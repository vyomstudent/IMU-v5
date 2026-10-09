import asyncio
import logging
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Callable, Optional, List, Tuple, Awaitable

from bleak import BleakClient, BleakScanner
from bleak.backends.device import BLEDevice


NUS_SERVICE_UUID = "6E400001-B5A3-F393-E0A9-E50E24DCCA9E"
NUS_NOTIFY_UUID = "6E400003-B5A3-F393-E0A9-E50E24DCCA9E"
NUS_WRITE_UUID = "6E400002-B5A3-F393-E0A9-E50E24DCCA9E"
logger = logging.getLogger(__name__)


def now_iso() -> str:
    return datetime.now(timezone.utc).astimezone().isoformat()


def bytes_to_hex(data: bytes) -> str:
    h = data.hex().upper()
    return " ".join(h[i : i + 2] for i in range(0, len(h), 2))


def pick_devices(selectors: List[str], timeout: float = 10.0) -> List[BLEDevice]:
    async def _pick() -> List[BLEDevice]:
        discovered = await BleakScanner.discover(timeout=timeout)
        out: List[Optional[BLEDevice]] = [None, None]
        for i, sel in enumerate(selectors):
            sel_l = sel.lower()
            for d in discovered:
                name = (d.name or "").lower()
                addr = getattr(d, "address", None) or getattr(d, "mac_address", None) or ""
                if sel_l in name.lower() or sel_l == addr.lower():
                    out[i] = d
                    break
        # fall back by address lookup
        for i, (d, sel) in enumerate(zip(out, selectors)):
            if d is None and (":" in sel or len(sel) in (12, 17)):
                found = await BleakScanner.find_device_by_address(sel, timeout=max(3.0, timeout / 2))
                if found:
                    out[i] = found
        if out[0] is None or out[1] is None:
            missing = [i for i, x in enumerate(out) if x is None]
            raise RuntimeError(f"Could not resolve devices for indices: {missing}")
        return [out[0], out[1]]  # type: ignore

    return asyncio.get_event_loop().run_until_complete(_pick())


class FrameParser:
    def __init__(self):
        self.buffer = bytearray()

    def feed(self, data: bytes) -> List[Tuple[bytes, str]]:
        frames: List[Tuple[bytes, str]] = []
        self.buffer.extend(data)
        # trim leading stray zeros
        while self.buffer and self.buffer[0] == ord('0'):
            del self.buffer[0]
        if len(self.buffer) > 8192:
            del self.buffer[:-4096]

        while True:
            start_idx = None
            start_ch = None
            for ch in (ord('{'), ord('[')):
                try:
                    idx = self.buffer.index(ch)
                    if start_idx is None or idx < start_idx:
                        start_idx = idx
                        start_ch = ch
                except ValueError:
                    pass
            if start_idx is None:
                break
            if start_idx > 0:
                del self.buffer[:start_idx]
            end_ch = ord('}') if start_ch == ord('{') else ord(']')
            try:
                end_idx = self.buffer.index(end_ch, 1)
            except ValueError:
                break
            frame = bytes(self.buffer[: end_idx + 1])
            del self.buffer[: end_idx + 1]
            while self.buffer and self.buffer[0] == ord('0'):
                del self.buffer[0]
            chunk_hex = bytes_to_hex(data)
            frames.append((frame, chunk_hex))
        return frames


class DualBleLogger:
    def __init__(
        self,
        devices: List[BLEDevice],
        notify_uuid: str = NUS_NOTIFY_UUID,
        write_uuid: str = NUS_WRITE_UUID,
        adapters: Optional[List[Optional[str]]] = None,
    ):

        self.notify_uuid = notify_uuid
        self.write_uuid = write_uuid
        self._clients: List[BleakClient] = []
        for idx, dev in enumerate(devices):
            bluez_args = {}
            adapter = adapters[idx] if adapters and idx < len(adapters) else None
            if adapter:
                bluez_args["adapter"] = adapter
            self._clients.append(BleakClient(dev, bluez=bluez_args))
        self._parsers = {i: FrameParser() for i in range(len(devices))}
        self._connect_lock = asyncio.Lock()

    async def connect(self):
        async with self._connect_lock:
            for idx, client in enumerate(self._clients):
                if client.is_connected:
                    continue
                logger.info("Connecting BLE device %d/%d...", idx + 1, len(self._clients))
                await client.connect(timeout=20.0)
            logger.info("BLE devices connected.")

    async def connect_and_start_notify_chunks(
        self,
        on_chunk: Callable[[int, bytes], None],
    ) -> None:
        async with self._connect_lock:
            for idx, client in reversed(list(enumerate(self._clients))):
                if not client.is_connected:
                    logger.info("Connecting BLE device %d/%d...", idx + 1, len(self._clients))
                    await client.connect(timeout=20.0)

            # Start notifications in reverse order once, to see whether
            # bring-up order affects sustained throughput.
            for idx in range(len(self._clients)):
                client = self._clients[idx]

                def handler(_, data: bytes, device_idx: int = idx):
                    on_chunk(device_idx, data)

                logger.info("Starting notifications for BLE device %d/%d...", idx + 1, len(self._clients))
                await client.start_notify(self.notify_uuid, handler)

            logger.info("BLE devices connected and notifications armed.")

    async def start_notify(self, on_frame: Callable[[int, bytes, str], Awaitable[None]]):
        async def process(idx: int, data: bytes):
            for frame, chunk_hex in self._parsers[idx].feed(data):
                await on_frame(idx, frame, chunk_hex)

        def handler_factory(idx: int):
            def handler(_, data: bytes):
                asyncio.create_task(process(idx, data))
            return handler

        for i, c in enumerate(self._clients):
            await c.start_notify(self.notify_uuid, handler_factory(i))

    async def start_notify_chunks(self, on_chunk: Callable[[int, bytes], None]):
        def handler_factory(idx: int):
            def handler(_, data: bytes):
                on_chunk(idx, data)
            return handler

        for i, c in enumerate(self._clients):
            await c.start_notify(self.notify_uuid, handler_factory(i))

    async def stop_notify(self):
        await asyncio.gather(*(c.stop_notify(self.notify_uuid) for c in self._clients if c.is_connected))

    async def disconnect(self):
        await asyncio.gather(*(c.disconnect() for c in self._clients if c.is_connected))

    async def broadcast(self, data: bytes, delay_s: float = 0.02):
        for c in self._clients:
            await c.write_gatt_char(self.write_uuid, data, response=False)
            await asyncio.sleep(max(0.0, delay_s))

    async def broadcast_serial(self, data: bytes, delay_s: float = 0.5):
        async with self._connect_lock:
            for idx, c in enumerate(self._clients):
                if not c.is_connected:
                    continue
                logger.info("Sending command to BLE device %d/%d...", idx + 1, len(self._clients))
                await c.write_gatt_char(self.write_uuid, data, response=False)
                if idx + 1 < len(self._clients):
                    await asyncio.sleep(max(0.0, delay_s))

    async def broadcast_to_indices_serial(
        self,
        commands: List[Tuple[int, bytes]],
        delay_s: float = 0.5,
    ) -> None:
        async with self._connect_lock:
            for idx, data in commands:
                if idx < 0 or idx >= len(self._clients):
                    raise IndexError(f"BLE device index out of range: {idx}")
                client = self._clients[idx]
                if not client.is_connected:
                    logger.info("Skipping disconnected BLE device %d/%d...", idx + 1, len(self._clients))
                    continue
                logger.info("Sending command to BLE device %d/%d: %r", idx + 1, len(self._clients), data)
                await client.write_gatt_char(self.write_uuid, data, response=False)
                await asyncio.sleep(max(0.0, delay_s))

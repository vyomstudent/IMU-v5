#!/usr/bin/env python3

import asyncio
import logging
import paho.mqtt.client as mqtt

logger = logging.getLogger('dji_cloud_service_logger')


class AsyncioHelper:
    def __init__(self, loop, client):
        """
        https://github.com/eclipse/paho.mqtt.python/blob/master/examples/loop_asyncio.py
        :param loop:
        :param client:
        """
        self.misc = None
        self.loop = loop
        self.client = client
        self.client.on_socket_open = self.on_socket_open
        self.client.on_socket_close = self.on_socket_close
        self.client.on_socket_register_write = self.on_socket_register_write
        self.client.on_socket_unregister_write = self.on_socket_unregister_write


    def on_socket_open(self, client, userdata, sock):
        # logger.info("Socket opened", extra=self.logging_info)

        def cb():
            # logger.debug("Socket is readable, calling loop_read", extra=self.logging_info)
            client.loop_read()

        self.loop.add_reader(sock, cb)
        self.misc = self.loop.create_task(self.misc_loop())

    def on_socket_close(self, client, userdata, sock):
        logger.info("Socket closed")
        self.loop.remove_reader(sock)
        self.misc.cancel()

    def on_socket_register_write(self, client, userdata, sock):
        # logger.debug("Watching socket for writability.", extra=self.logging_info)

        def cb():
            # logger.debug("Socket is writable, calling loop_write", extra=self.logging_info)
            client.loop_write()

        self.loop.add_writer(sock, cb)

    def on_socket_unregister_write(self, client, userdata, sock):
        # logger.debug("Stop watching socket for writability", extra=self.logging_info)
        self.loop.remove_writer(sock)

    async def misc_loop(self):
        # logger.debug("misc_loop started", extra=self.logging_info)
        while self.client.loop_misc() == mqtt.MQTT_ERR_SUCCESS:
            try:
                await asyncio.sleep(0.001)
            except asyncio.CancelledError as e:
                logger.error(f"Failure message received from MQTT: {e}")
                break

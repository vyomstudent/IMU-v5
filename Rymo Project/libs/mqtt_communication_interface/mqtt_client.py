
import asyncio
import os
import socket
import uuid
import traceback
import logging
import paho.mqtt.client as mqtt
from paho.mqtt.client import Client
from mqtt_communication_interface.mqtt_asyncio_helper import AsyncioHelper

class MqttClientManager:
    client: Client = None

    def __init__(self,logger):
        """
        This class manages a single mqtt connection with broker.
        """
        self.connected_flag = False
        self.logger = logger
        self.subscribed_topics = []
        self.topics_to_add_cbs = []
        logger.info(f"MqttClient Initialized for Service")

    async def subscribe_to_topics(self, topic_callback_dict: dict):
        """
        :return:
        """
        try:
            print(f"sasasasas")
            while self.client is None:
                await asyncio.sleep(0.25)
            for topic in topic_callback_dict.keys():
                if topic not in self.subscribed_topics:
                    self.client.subscribe(topic, qos=1)
                    self.logger.info(f"Subscribed to topic: {topic}\n\n\n\n\n")
                    self.subscribed_topics.append(topic)
                    self.topics_to_add_cbs.append(topic)

            for topic, value in topic_callback_dict.items():
                if topic in self.topics_to_add_cbs:
                    self.client.message_callback_add(topic, value)

            self.logger.info(f"[MqttClient] Added devices mqtt callbacks for "
                        f"topics: {topic_callback_dict.keys()}")
        except Exception as e:
            self.logger.exception(f"[MqttClient] Unable to subscribe to "
                             f"topics due to error: {str(e)}",
                             exc_info=True)

    def resubscribe(self):
        try:
            for topic in self.subscribed_topics:
                self.client.subscribe(topic, qos=1)
                self.logger.info(f"[MqttClient] Subscribed to topic: {topic}")
            return True
        except Exception as e:
            self.logger.exception(
                f"[MqttClient] Unable to subscribe to topic: {topic} due to ERROR: {str(e)}",
                exc_info=True)
            return False

    def unsubscribe_to_topics(self, topic_list):
        try:
            for topic in topic_list:
                if topic in self.subscribed_topics:
                    self.client.message_callback_remove(topic)
                    self.client.unsubscribe(topic)
                    self.logger.info(f"[MqttClient] Unsubscribed to topic: {topic}")
                else:
                    self.logger.info(f"[MqttClient] Cannot "
                                f"unsubscribe to topic as it is not subscribed: {topic}")
        except Exception as e:
            self.logger.exception(f"[MqttClient] Unable to "
                             f"unsubscribe ERROR: {str(e)}", exc_info=True)

    def on_message(self, client, userdata, msg: mqtt.MQTTMessage):
        """
        Called when data is received from broker through the subscriptions
        :param client:
        :param userdata:
        :param msg:
        """
        pass

    def on_connect(self, client, userdata, flags, reason_code, properties):
        """
        Called when a successful connection is made to the AWS IOT MQTT Broker
        :param client:
        :param userdata:
        :param flags:
        :param rc:
        """
        self.connected_flag = True
        self.logger.info(f"[MqttClient] Connected to MQTT Broker!")
        self.resubscribe()

    def on_disconnect(self, client, userdata, flags, reason_code, properties):
        """
        Called when the client is disconnected from the AWS IOT MQTT Broker
        :param client:
        :param userdata:
        :param rc:
        """
        self.connected_flag = False
        self.logger.error(f"[MqttClient] Disconnected from MQTT Broker: {reason_code}")

    def on_subscribe(self, client, userdata, mid, reason_codes, properties):
        """
        Called when the client is disconnected from the AWS IOT MQTT Broker
        :param client:
        :param obj:
        :param mid:
        :param granted_qos:
        """
        # logger.debug(f"Subscribed to: {mid}, {obj}, {granted_qos}")
        pass

    async def make_connection(self, loop, host, port, ssl_enabled=False, client_id=str(uuid.uuid4()), username=None, password=None):
        """
        Async function runs in a loop for maintaining connection
        to the MQTT broker.
        Initiates reconnect calls if the disconnected from MQTT Broker
        """
        self.logger.info(f"[MqttClient] MQTT Connection Loop Started with MQTT Details: \n"
                    f"MQTT Host: {host} \n"
                    f"MQTT Port: {port} \n"
                    f"SSL Enabled: {ssl_enabled} \n"
                    f"Client ID: {client_id} \n"
                    f"Username: {username} \n"
                    f"Password: {password} \n")

        self.client = mqtt.Client(callback_api_version=mqtt.CallbackAPIVersion.VERSION2, client_id=client_id)
        if ssl_enabled:
            self.client.tls_set()
        if username is not None and password is not None:
            self.client.username_pw_set(username=username, password=password)
        alert_already_sent = False
        while asyncio.get_event_loop().is_running():
            if not self.connected_flag:
                try:
                    self.client.on_connect = self.on_connect
                    self.client.on_message = self.on_message
                    self.client.on_disconnect = self.on_disconnect
                    self.client.on_subscribe = self.on_subscribe
                    AsyncioHelper(loop, self.client)
                    self.client.connect(host, port, 30)
                    self.client.socket().setsockopt(socket.SOL_SOCKET, socket.SO_SNDBUF, 2048)
                except Exception as e:
                    err = f"[MqttClient] Could not connect to MQTT Broker for {client_id}: {str(e)}\n" \
                          f"{traceback.format_exc()}"
                    self.logger.exception(err)
            await asyncio.sleep(3)

    async def wait_until_connected(self):
        """
        This function helps to wait until the client is connected to the broker
        """
        i = 0
        while not self.connected_flag:
            i += 1
            self.logger.warning(f"[MqttClient] Waiting for MQTT connection...{i}")
            await asyncio.sleep(1.0)

    async def publish(self, topic, msg, delay=0):
        try:
            if delay > 0:
                topic = f"$delayed/{delay}/{topic}"
            self.client.publish(topic, msg, qos=1)
            return True
        except Exception as e:
            self.logger.exception(f"[MqttClient] [{topic}] Failed to send data "
                             f"over MQTT for topic [{topic}] with arguments {str(msg)}. "
                             f"Error: {str(e)}", exc_info=True)
            return False

    def on_shutdown(self):
        err = f"[MqttClient] Disconnecting from  MQTT broker!"
        self.logger.warning(err)
        self.client.disconnect()

    def disconnect(self):
        self.client.disconnect()

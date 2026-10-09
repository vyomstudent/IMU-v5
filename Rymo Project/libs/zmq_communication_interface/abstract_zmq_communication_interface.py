import asyncio
import zmq
import zmq.asyncio
import logging
from typing import Callable, Dict, Awaitable, Optional



class ZMQInterface:
    def __init__(self):
        self.context = zmq.asyncio.Context()
        self.publisher = self.context.socket(zmq.PUB)
        self.publisher.setsockopt(zmq.LINGER, 0)
        self.subscriber = self.context.socket(zmq.SUB)
        self.subscriber.setsockopt(zmq.LINGER, 0)
        self.logger = logging.getLogger(__name__)


    async def bind_publisher(self, endpoint: str):
        self.publisher.bind(endpoint)

    async def bind_subscriber(self, endpoint: str):
        print(f"Binding subscriber to endpoint: {endpoint}")    
        self.subscriber.connect(endpoint)


    async def publish(self, topic: str, message: bytes):
        # print(f"Publishing {message} to {topic}")
        await self.publisher.send_multipart([
            topic.encode('utf-8'),  # Ensure topic is bytes
            message
        ])


    async def _receive_loop(self, topic_callbacks: Dict[str, Callable[[str, str], Awaitable[None]]]):
        """
        Internal loop to receive and process messages.
        
        :param topic_callbacks: Dictionary of topics and their callback functions
        """

        while True:
            x = await self.subscriber.recv_multipart()   
            try:
                
                # topic, message = x
                topic = x[0]
                message = x[-1]
                
                if isinstance(topic, bytes):
                    decoded_topic = topic.decode('utf-8')
               
                # Find and execute appropriate callback
                    callback = topic_callbacks.get(decoded_topic)
                    
                    if callback is not None:
                        await callback(decoded_topic, message)
                    else:
                        self.logger.warning(f"No callback found for topic: {decoded_topic}")
                
            except Exception as e:
                self.logger.error(f"Error in receive loop: {e} \n {x}",exc_info=True)
                

                
            


    async def subscribe(self, 
                        topic_callbacks: Dict[str, Callable[[str, str], Awaitable[None]]]):
        """
        Subscribe to multiple topics with their respective callbacks.
        
        :param topic_callbacks: Dictionary of topics and their callback functions
        """
        # Subscribe to topics
        for topic in topic_callbacks.keys():
            print(f"Subscribing to topic: {topic.encode('utf-8')}")
            self.subscriber.subscribe(topic.encode('utf-8'))
            # await asyncio.sleep(0.1)
        
        # Start receiving messages    
        asyncio.create_task(self._receive_loop(topic_callbacks))


    async def close(self):
        """
        Close publisher and subscriber sockets.
        """
        if self.publisher:
            self.publisher.close()
        if self.subscriber:
            self.subscriber.close()

import java.io.File;

import javax.jms.Connection;
import javax.jms.DeliveryMode;
import javax.jms.Message;
import javax.jms.MessageConsumer;
import javax.jms.MessageProducer;
import javax.jms.Queue;
import javax.jms.Session;
import javax.jms.TextMessage;
import javax.jms.Topic;
import javax.jms.TopicSubscriber;

import org.apache.activemq.ActiveMQConnectionFactory;
import org.apache.activemq.broker.BrokerService;
import org.apache.activemq.broker.TransportConnector;
import org.apache.activemq.store.kahadb.KahaDBPersistenceAdapter;

public final class BrokerFixtureProducer {
    private BrokerFixtureProducer() {
    }

    public static void main(String[] args) throws Exception {
        if (args.length != 1) {
            throw new IllegalArgumentException("Expected one KahaDB output directory");
        }

        File storeDirectory = new File(args[0]).getCanonicalFile();
        BrokerService broker = new BrokerService();
        broker.setBrokerName("mq-watcher-fixture");
        broker.setPersistent(true);
        broker.setUseJmx(false);
        broker.setUseShutdownHook(false);
        broker.setDeleteAllMessagesOnStartup(true);
        broker.setSchedulerSupport(false);

        File temporaryStoreDirectory = new File(storeDirectory.getParentFile(), "broker-temp");
        broker.setDataDirectoryFile(storeDirectory.getParentFile());
        broker.setTmpDataDirectory(temporaryStoreDirectory);

        KahaDBPersistenceAdapter adapter = new KahaDBPersistenceAdapter();
        adapter.setDirectory(storeDirectory);
        adapter.setJournalMaxFileLength(1024 * 1024);
        adapter.setPreallocationScope("entire_journal");
        adapter.setEnableJournalDiskSyncs(true);
        adapter.setCleanupInterval(Long.MAX_VALUE);
        broker.setPersistenceAdapter(adapter);

        TransportConnector connector = broker.addConnector("tcp://127.0.0.1:0");
        broker.start();
        if (!broker.waitUntilStarted(30000L)) {
            throw new IllegalStateException("Broker did not start within 30 seconds");
        }

        try {
            ActiveMQConnectionFactory factory = new ActiveMQConnectionFactory(connector.getPublishableConnectString());
            factory.setConnectionIDPrefix("fixture");
            createPendingQueueMessage(factory);
            createAcknowledgedQueueMessage(factory);
            createCommittedTransaction(factory);
            createOfflineDurableTopicMessage(factory);
        } finally {
            broker.stop();
            broker.waitUntilStopped();
        }

        File lock = new File(storeDirectory, "lock");
        if (lock.exists() && !lock.delete()) {
            throw new IllegalStateException("Could not remove stopped-broker lock file: " + lock);
        }
        deleteRecursively(temporaryStoreDirectory);
    }

    private static void createPendingQueueMessage(ActiveMQConnectionFactory factory) throws Exception {
        Connection connection = factory.createConnection();
        try {
            Session session = connection.createSession(false, Session.AUTO_ACKNOWLEDGE);
            Queue queue = session.createQueue("ORDERS");
            MessageProducer producer = session.createProducer(queue);
            producer.setDeliveryMode(DeliveryMode.PERSISTENT);
            TextMessage message = session.createTextMessage("fixture-order-pending");
            message.setStringProperty("fixtureScenario", "queue-pending");
            producer.send(message);
            producer.close();
            session.close();
        } finally {
            connection.close();
        }
    }

    private static void createAcknowledgedQueueMessage(ActiveMQConnectionFactory factory) throws Exception {
        Connection connection = factory.createConnection();
        try {
            Session session = connection.createSession(false, Session.CLIENT_ACKNOWLEDGE);
            Queue queue = session.createQueue("ACK.TEST");
            MessageProducer producer = session.createProducer(queue);
            producer.setDeliveryMode(DeliveryMode.PERSISTENT);
            producer.send(session.createTextMessage("fixture-acknowledged"));
            producer.close();

            MessageConsumer consumer = session.createConsumer(queue);
            connection.start();
            Message received = consumer.receive(10000L);
            if (received == null) {
                throw new IllegalStateException("ACK fixture message was not received");
            }
            received.acknowledge();
            consumer.close();
            session.close();
        } finally {
            connection.close();
        }
    }

    private static void createCommittedTransaction(ActiveMQConnectionFactory factory) throws Exception {
        Connection connection = factory.createConnection();
        try {
            Session session = connection.createSession(true, Session.SESSION_TRANSACTED);
            Queue queue = session.createQueue("PAYMENTS");
            MessageProducer producer = session.createProducer(queue);
            producer.setDeliveryMode(DeliveryMode.PERSISTENT);
            producer.send(session.createTextMessage("fixture-transaction-commit"));
            session.commit();
            producer.close();
            session.close();
        } finally {
            connection.close();
        }
    }

    private static void createOfflineDurableTopicMessage(ActiveMQConnectionFactory factory) throws Exception {
        Connection durableConnection = factory.createConnection();
        try {
            durableConnection.setClientID("fixture-durable-client");
            Session session = durableConnection.createSession(false, Session.AUTO_ACKNOWLEDGE);
            Topic topic = session.createTopic("PRICES");
            TopicSubscriber subscriber = session.createDurableSubscriber(topic, "prices-sub");
            durableConnection.start();
            subscriber.close();
            session.close();
        } finally {
            durableConnection.close();
        }

        Connection producerConnection = factory.createConnection();
        try {
            Session session = producerConnection.createSession(false, Session.AUTO_ACKNOWLEDGE);
            Topic topic = session.createTopic("PRICES");
            MessageProducer producer = session.createProducer(topic);
            producer.setDeliveryMode(DeliveryMode.PERSISTENT);
            producer.send(session.createTextMessage("fixture-durable-pending"));
            producer.close();
            session.close();
        } finally {
            producerConnection.close();
        }
    }

    private static void deleteRecursively(File file) throws Exception {
        if (!file.exists()) {
            return;
        }
        if (file.isDirectory()) {
            File[] children = file.listFiles();
            if (children != null) {
                for (File child : children) {
                    deleteRecursively(child);
                }
            }
        }
        if (!file.delete()) {
            throw new IllegalStateException("Could not remove fixture work path: " + file);
        }
    }
}

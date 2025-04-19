import DNS from 'dns';
import ValidateIP from 'ip-validator';
import Socks from 'simple-socks';
import ContinuationLocalStorage from 'continuation-local-storage';

const DnsLookup = DNS.lookup;
const continuation = ContinuationLocalStorage.createNamespace('proxies');

DNS.lookup = function (domain, options, callback) {
    continuation.run(() => {
        const proxy = continuation.get('proxy');

        if (proxy && proxy.overrides && proxy.overrides[domain]) {
            const address = proxy.overrides[domain] || '';

            if (ValidateIP.ipv4(address)) {
                return callback(null, address, 4);
            } else if (ValidateIP.ipv6(address)) {
                return callback(null, address, 6);
            }
        }

        return DnsLookup.call(this, domain, options, callback);
    });
};

function createSocksServer (proxy, log) {
    const socks = Socks.createServer({
        connectionFilter: (destination, source, callback) => {
            continuation.run(() => {
                continuation.set('proxy', proxy);

                callback();

                continuation.set('proxy', null);
            });
        }
    });

    socks.on('connection', (connection) => {
        proxy.sources.push(connection);
    });

    socks.on('proxyConnect', (info, destination) => {
        continuation.run(() => {
            continuation.set('proxy', proxy);
        });

        try {
            const counter = {
                uploadBytes: 0,
                downloadBytes: 0
            };

            proxy.counters.push(counter);
            proxy.destinations.push(destination);

            destination.on('data', () => {
                counter.uploadBytes = destination.bytesWritten;
                counter.downloadBytes = destination.bytesRead;
            });
        } catch (err) {
            log.error(`Error from proxy connect handler: \n`, err);
        }
    });

    socks.on('proxyError', err => {
        log.debug(`Proxy encountered an error: \n`, err);
    });

    return socks;
}

export function createProxy (port, log) {
    const proxy = {
        port: port,
        counters: [],
        sources: [],
        destinations: [],
        overrides: {},
        getUploadBytes () {
            return proxy.counters.map(c => c.uploadBytes).reduce((a, b) => a + b, 0);
        },
        getDownloadBytes () {
            return proxy.counters.map(c => c.downloadBytes).reduce((a, b) => a + b, 0);
        },
        async open () {
            proxy.socks = createSocksServer(proxy, log);

            return await new Promise((resolve, reject) => {
                try {
                    proxy.socks.listen({ port: proxy.port }, async () => {
                        log.debug(`Opened proxy server on ${proxy.port}`);

                        resolve(proxy);
                    });
                } catch (err) {
                    reject(err);
                }
            });
        },
        async close () {
            return await new Promise((resolve, reject) => {
                log.debug(`Closing proxy server on ${proxy.port}`);

                proxy.sources.splice(0).forEach(connection => {
                    try {
                        connection.destroy();
                    } catch (err) {
                        log.warn(`Proxy failed to close and destroy inbound connection ${connection}`, err);
                    }
                });

                proxy.socks.close(err => {
                    if (err) {
                        log.error(`Failed to close proxy server on ${proxy.port}`, err);

                        reject(err);
                    } else {
                        log.debug(`Closed proxy server on ${proxy.port}`);

                        const destinations = proxy.destinations.splice(0);

                        if (destinations && destinations.length) {
                            log.debug(`Destroying ${destinations.length} destinations for proxy on port ${proxy.port}`);

                            destinations.forEach(destination => destination.destroy());
                        }

                        resolve(proxy);
                    }
                });
            })
        },
        async bounce () {
            await proxy.close();
            await proxy.open();

            proxy.counters.splice(0);
        }
    };

    return proxy;
}

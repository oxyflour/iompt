# iompt
Multipath tunnel using socket.io xhr-pollings to pass through firewalls.

__It's an experimental tool. Use it at your own risk.__

```
  Usage: iompt [options]

  Options:

    -h, --help                                         output usage information
    -V, --version                                      output the version number
    -P, --peer <[concurrency*]url>                           iompt server url, required as client
    -F, --forward <[host:]port:remoteHost:remotePort>  forward host:port to remoteHost:remotePort, required as client
    -l, --listen <[host:]port>                         listen port, required as server

```
# usage
start as server and listen at port 3000 and 3001
```
iompt -l 3000 -l 3001
```
start as client, start 5 connections to the server at localhost:3000 and another 5 to localhost:3001, to forward local port 10022 to localhost:22
```
iompt -P 5*http://localhost:3000 -P 5*http://localhost:3001 -F 10022:localhost:22
```
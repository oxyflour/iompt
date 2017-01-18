# iompt
Multipath tunnel using socket.io xhr-pollings to pass through firewalls.

__It's an experimental tool. Use it at your own risk.__

```
  Usage: iompt [options]

  Options:

    -h, --help                                         output usage information
    -V, --version                                      output the version number
    -P, --peer <[concurrency*]url>                     iompt server url, required as client
    -F, --forward <[host:]port:remoteHost:remotePort>  forward host:port to remoteHost:remotePort, required as client
    -l, --listen <[host:]port>                         listen port, required as server
    --io-path <string>                                 socket.io path, default "/iompt/socket.io"
    --io-flush-interval <integer>                      milliseconds to flush data, default 30ms
    --io-max-buffer-size <integer>                     default 40
    --io-min-buffer-size <integer>                     default 30
    --idle-timeout <integer>                           seconds to wait before closing idle connection, default 30s
    --sock-throttle-interval <integer>                 milliseconds to pause/resume socket stream, default 20ms
    --sock-resume-buffer-size <integer>                default 10
    --sock-pause-buffer-size <integer>                 default 20
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
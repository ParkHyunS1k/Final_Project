// 로컬 화면 확인용. 브라우저 요청에 개발 신원 헤더를 붙여 next dev(AUTH_DEV_HEADERS=1)로 넘긴다.
// 운영(NODE_ENV=production)에서는 서버가 이 헤더를 무시한다(lib/auth.ts). Host·Origin은 그대로 둬 출처 검사를 통과한다.
// 사용: node scripts/dev-as.mjs <포트> <사용자 id> <표시 이름> [대상 포트=3102]
import http from 'node:http';
import net from 'node:net';

const [port = '3110', user = 'owner', name = '도윤', target = '3102'] = process.argv.slice(2);
http
  .createServer((req, res) => {
    const headers = {
      ...req.headers,
      'oai-authenticated-user-id': user,
      'oai-authenticated-user-email': `${user}@test.local`,
      'oai-authenticated-user-full-name': encodeURIComponent(name),
      'oai-authenticated-user-full-name-encoding': 'percent-encoded-utf-8',
    };
    const up = http.request(
      { host: '127.0.0.1', port: Number(target), path: req.url, method: req.method, headers },
      (r) => {
        res.writeHead(r.statusCode ?? 502, r.headers);
        r.pipe(res);
      },
    );
    up.on('error', (e) => {
      res.writeHead(502);
      res.end(String(e));
    });
    req.pipe(up);
  })
  // 개발 화면은 HMR 웹소켓이 연결돼야 hydration한다. 업그레이드 요청은 그대로 이어 준다.
  .on('upgrade', (req, socket, head) => {
    const up = net.connect(Number(target), '127.0.0.1', () => {
      const lines = [`${req.method} ${req.url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2)
        lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
      up.write(lines.join('\r\n') + '\r\n\r\n');
      up.write(head);
      socket.pipe(up).pipe(socket);
    });
    up.on('error', () => socket.destroy());
    socket.on('error', () => up.destroy());
  })
  .listen(Number(port), '127.0.0.1', () =>
    console.log(`http://127.0.0.1:${port} → :${target} as ${user}(${name})`),
  );

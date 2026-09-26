// 运输可信证明后台的 HTTP 接口（node:http，无第三方依赖）。
// 命令走 POST，查询走 GET；所有错误以 400 + { error } 返回。
import { createServer } from 'node:http';
import { pathToFileURL } from 'node:url';
import { createEventStore } from '../store/eventStore.js';
import { createProjection } from '../store/projection.js';
import { createCommands } from '../service/commands.js';
import * as queries from '../service/queries.js';

export function createApi({ commands, state, now = () => Date.now() }) {
  const post = {
    '/rules': (b) => commands.registerQualityRule(b),
    '/sensors': (b) => commands.registerSensor(b),
    '/sensors/calibrations': (b) => commands.calibrateSensor(b),
    '/boxes': (b) => commands.registerBox(b),
    '/boxes/bind': (b) => commands.bindSensor(b),
    '/boxes/unbind': (b) => commands.unbindSensor(b),
    '/boxes/opens': (b) => commands.recordBoxOpen(b),
    '/batches': (b) => commands.registerBatch(b),
    '/batches/load': (b) => commands.loadBatch(b),
    '/batches/unload': (b) => commands.unloadBatch(b),
    '/ops/rebox': (b) => commands.rebox(b),
    '/ops/consolidate': (b) => commands.consolidate(b),
    '/ops/split': (b) => commands.split(b),
    '/tasks': (b) => commands.createTask(b),
    '/tasks/attach': (b) => commands.attachBoxToTask(b),
    '/handovers': (b) => commands.recordHandover(b),
    '/readings': (b) => commands.ingestTemperatureSegment(b),
    '/releases': (b) => commands.issueRelease(b),
    '/releases/revoke': (b) => commands.revokeRelease(b),
    '/releases/confirm': (b) => commands.confirmRelease(b),
    '/dispositions': (b) => commands.recordDisposition(b),
    '/notifications/sent': (b) => commands.markNotificationSent(b),
  };

  function get(pathname, url) {
    let m = pathname.match(/^\/scan\/([^/]+)$/);
    if (m) {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      return queries.toIsoView(
        queries.scanBox(state, m[1], {
          from: from ? Date.parse(from) : undefined,
          to: to ? Date.parse(to) : undefined,
          now,
        }),
      );
    }
    m = pathname.match(/^\/batches\/([^/]+)\/evidence$/);
    if (m) {
      const from = url.searchParams.get('from');
      const to = url.searchParams.get('to');
      if (!from || !to) throw new Error('批次证据链查询需要 from 与 to 参数');
      return queries.toIsoView(
        queries.batchEvidence(state, m[1], { from: Date.parse(from), to: Date.parse(to) }),
      );
    }
    m = pathname.match(/^\/releases\/([^/]+)\/trace$/);
    if (m) return queries.toIsoView(queries.traceRelease(state, m[1]));
    if (pathname === '/notifications/pending') return queries.toIsoView(queries.pendingNotifications(state));
    throw new Error(`未知路径: ${pathname}`);
  }

  return createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    try {
      let result;
      if (req.method === 'POST' && post[url.pathname]) {
        result = post[url.pathname](await readJson(req));
      } else if (req.method === 'GET') {
        result = get(url.pathname, url);
      } else {
        res.writeHead(404, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'not found' }));
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(queries.toIsoView(result)));
    } catch (err) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: err.message }));
    }
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let body = '';
    req.on('data', (chunk) => (body += chunk));
    req.on('end', () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// 直接运行时启动服务：COLDCHAIN_DB 指定 JSONL 持久化文件（缺省纯内存），PORT 指定端口。
const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  const filePath = process.env.COLDCHAIN_DB || null;
  const store = createEventStore({ filePath });
  const { state } = createProjection(store);
  const commands = createCommands({ store, state });
  const server = createApi({ commands, state });
  const port = Number(process.env.PORT || 8080);
  server.listen(port, () => {
    console.log(`coldchain-trust 后台已启动: http://localhost:${port}（存储: ${filePath ?? '内存'}）`);
  });
}

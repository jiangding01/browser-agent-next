import http from "node:http";

const port = 4173;

const pages = new Map([
  ["/main.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Main Fixture</title></head>
  <body>
    <button id="main-action">Save</button>
    <iframe id="child-frame" src="/child.html"></iframe>
  </body>
</html>`],
  ["/child.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Child Fixture</title></head>
  <body>
    <button id="child-action">Child Action</button>
  </body>
</html>`],
  ["/oopif-main.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>OOPIF Main Fixture</title></head>
  <body>
    <button id="oopif-main-action">OOPIF Main</button>
    <iframe
      id="oopif-child-frame"
      src="http://localhost:4173/oopif-child.html"
    ></iframe>
  </body>
</html>`],
  ["/oopif-child.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>OOPIF Child Fixture</title></head>
  <body>
    <button id="oopif-child-action">OOPIF Child Action</button>
  </body>
</html>`],
]);

const server = http.createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1:" + port);
  const body = pages.get(url.pathname);

  if (!body) {
    response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
    response.end("not found");
    return;
  }

  response.writeHead(200, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(body);
});

server.listen(port, "127.0.0.1");

const close = () => server.close(() => process.exit(0));
process.on("SIGINT", close);
process.on("SIGTERM", close);

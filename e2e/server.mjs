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
    <script>
      document.querySelector("#oopif-child-action")?.addEventListener(
        "click",
        (event) => {
          const button = event.currentTarget;
          if (!(button instanceof HTMLButtonElement)) return;
          button.textContent = "OOPIF Clicked";
          document.body.dataset.clicked = "true";
        },
      );
    </script>
  </body>
</html>`],
  ["/oopif-transform-main.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>OOPIF Transform Main Fixture</title>
    <style>
      html, body { margin: 0; min-height: 1800px; }
      #before-transform-frame { height: 900px; }
      #oopif-transform-frame {
        display: block;
        width: 360px;
        height: 220px;
        margin-left: 180px;
        border: 10px solid #333;
        transform-origin: 0 0;
        transform: rotate(4deg) scale(0.92);
      }
    </style>
  </head>
  <body>
    <div id="before-transform-frame"></div>
    <iframe
      id="oopif-transform-frame"
      src="http://localhost:4173/oopif-transform-child.html"
    ></iframe>
  </body>
</html>`],
  ["/oopif-transform-child.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>OOPIF Transform Child Fixture</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
      }
      body {
        display: grid;
        place-items: center;
      }
      #oopif-transform-action {
        width: 180px;
        height: 64px;
      }
    </style>
  </head>
  <body>
    <button id="oopif-transform-action">Transformed OOPIF Action</button>
    <script>
      document.querySelector("#oopif-transform-action")?.addEventListener(
        "click",
        (event) => {
          const button = event.currentTarget;
          if (!(button instanceof HTMLButtonElement)) return;
          button.textContent = "Transformed OOPIF Clicked";
          document.body.dataset.clicked = "true";
        },
      );
    </script>
  </body>
</html>`],
  ["/oopif-nested-main.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Nested OOPIF Main Fixture</title>
    <style>
      html, body { margin: 0; }
      #oopif-nested-parent-frame {
        display: block;
        width: 440px;
        height: 280px;
        margin: 60px;
        border: 8px solid #245;
      }
    </style>
  </head>
  <body>
    <iframe
      id="oopif-nested-parent-frame"
      src="http://localhost:4173/oopif-nested-parent.html"
    ></iframe>
  </body>
</html>`],
  ["/oopif-nested-parent.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Nested OOPIF Parent Fixture</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
      }
      body { position: relative; }
      #oopif-nested-child-frame {
        display: block;
        width: 300px;
        height: 160px;
        margin: 40px;
        border: 6px solid #473;
      }
    </style>
  </head>
  <body>
    <iframe
      id="oopif-nested-child-frame"
      src="http://127.0.0.1:4173/oopif-nested-child.html"
    ></iframe>
  </body>
</html>`],
  ["/oopif-nested-child.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Nested OOPIF Child Fixture</title>
    <style>
      html, body {
        margin: 0;
        width: 100%;
        height: 100%;
      }
      body {
        display: grid;
        place-items: center;
      }
      #oopif-nested-action {
        width: 180px;
        height: 64px;
      }
    </style>
  </head>
  <body>
    <button id="oopif-nested-action">Nested OOPIF Action</button>
    <script>
      document.querySelector("#oopif-nested-action")?.addEventListener(
        "click",
        (event) => {
          const button = event.currentTarget;
          if (!(button instanceof HTMLButtonElement)) return;
          button.textContent = "Nested OOPIF Clicked";
          document.body.dataset.clicked = "true";
        },
      );
    </script>
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

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
  ["/done.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Done Fixture</title></head>
  <body>
    <p id="done">Done</p>
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
  ["/oopif-delayed-child-main.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Delayed OOPIF Main Fixture</title></head>
  <body>
    <button id="oopif-main-action">OOPIF Main</button>
    <iframe id="oopif-child-frame"></iframe>
    <script>
      setTimeout(() => {
        document.querySelector("#oopif-child-frame").src =
          "http://localhost:4173/oopif-child.html";
      }, 2250);
    </script>
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
  ["/strict-write.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Strict Write Fixture</title>
    <style>
      body { font: 14px sans-serif; }
      label { display: block; margin: 4px 0; }
      #covered-wrap { position: relative; display: inline-block; }
      #cover { position: absolute; inset: 0; background: rgba(0,0,0,0.3); }
    </style>
  </head>
  <body>
    <label>Full name <input aria-label="Full name" id="name" value="old value"></label>
    <label>Notes <textarea aria-label="Notes" id="notes"></textarea></label>
    <label>Email <input aria-label="Email" id="email" type="email"></label>
    <label>Password <input aria-label="Password" id="password" type="password"></label>
    <label>Read only <input aria-label="Read only" id="readonly" readonly value="fixed"></label>
    <label>Age <input aria-label="Age" id="age" type="number"></label>
    <label>Code <input aria-label="Code" id="limited" maxlength="3"></label>
    <label>Clear me <input aria-label="Clear me" id="clearme" value="to clear"></label>
    <label>Already empty <input aria-label="Already empty" id="empty"></label>
    <label>Focus thief <input aria-label="Focus thief" id="victim"></label>
    <label>Stolen <input aria-label="Stolen" id="thief"></label>
    <label>Flips to password <input aria-label="Flips to password" id="flip"></label>
    <span id="covered-wrap"><label>Covered <input aria-label="Covered" id="covered"></label><span id="cover"></span></span>
    <div id="shadow-host"></div>
    <iframe id="child-frame" src="/strict-write-child.html" width="400" height="60"></iframe>
    <script>
      window.inputLog = [];
      const record = (event) => {
        const target = event.composedPath()[0];
        window.inputLog.push({
          id: target.id,
          trusted: event.isTrusted,
          inputType: event.inputType,
        });
      };
      document.addEventListener("input", record, true);
      window.focusLog = [];
      document.addEventListener("focusin", (event) => {
        window.focusLog.push(event.composedPath()[0].id);
      }, true);
      document.getElementById("victim").addEventListener("focus", () => {
        document.getElementById("thief").focus();
      });
      document.getElementById("flip").addEventListener("focus", (event) => {
        event.target.type = "password";
      });
      const root = document.getElementById("shadow-host").attachShadow({ mode: "open" });
      root.innerHTML = '<label>Shadow field <input aria-label="Shadow field" id="shadow-input"></label>';
      root.addEventListener("input", record, true);
    </script>
  </body>
</html>`],
  ["/strict-write-child.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Strict Write Child</title></head>
  <body>
    <label>Child field <input aria-label="Child field" id="child-input"></label>
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

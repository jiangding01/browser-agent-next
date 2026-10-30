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
      body { font: 12px sans-serif; margin: 4px; }
      label { display: inline-block; margin: 2px 8px 2px 0; }
      textarea { height: 18px; vertical-align: middle; }
      #covered-wrap { position: relative; display: inline-block; }
      #cover { position: absolute; inset: 0; background: rgba(0,0,0,0.3); }
      #masked { -webkit-text-security: disc; }
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
    <label>One-time code <textarea aria-label="One-time code" id="otp" autocomplete="one-time-code"></textarea></label>
    <label>Masked <input aria-label="Masked" id="masked"></label>
    <label>Masks on focus <input aria-label="Masks on focus" id="masks"></label>
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
      document.getElementById("masks").addEventListener("focus", (event) => {
        event.target.style.webkitTextSecurity = "disc";
      });
      const root = document.getElementById("shadow-host").attachShadow({ mode: "open" });
      root.innerHTML =
        '<style>.wrap{position:relative;display:inline-block}.veil{position:absolute;inset:0;background:rgba(0,0,0,.3)}</style>' +
        '<label>Shadow field <input aria-label="Shadow field" id="shadow-input"></label>' +
        '<span class="wrap"><label>Shadow covered <input aria-label="Shadow covered" id="shadow-covered"></label><span class="veil"></span></span>' +
        '<button id="shadow-button">Shadow button</button>';
      root.addEventListener("input", record, true);
      window.shadowClicks = 0;
      root.getElementById("shadow-button").addEventListener("click", (event) => {
        if (event.isTrusted) window.shadowClicks += 1;
      });
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
  ["/strict-actions.html", `<!doctype html>
<html>
  <head>
    <meta charset="utf-8">
    <title>Strict Actions Fixture</title>
    <style>
      body { font: 11px sans-serif; margin: 4px; }
      section { margin: 2px 0; }
      input, select { font-size: 11px; width: 90px; }
      form { display: inline-block; margin: 0 6px 0 0; }
      .wrap { position: relative; display: inline-block; }
      .veil { position: absolute; inset: 0; background: rgba(0,0,0,0.3); }
      #listbox { display: inline-block; padding: 0 4px; border: 1px solid #999; }
    </style>
  </head>
  <body>
    <section id="select-area">
      <select aria-label="City" id="city">
        <option selected>北京</option>
        <option>上海</option>
        <option>广州</option>
        <option>Dup</option>
        <option>Dup</option>
        <option label="Shown">Real</option>
        <option disabled>Disabled opt</option>
        <option hidden>Hidden opt</option>
        <optgroup label="Group" hidden><option>Grouped</option></optgroup>
        <option id="rich-option"></option>
      </select>
      <select aria-label="Multi" id="multi" multiple size="1"><option>One</option><option>Two</option></select>
      <select aria-label="Exp month" id="expmonth" autocomplete="cc-exp-month"><option>01</option><option>02</option></select>
      <select aria-label="Reverter" id="reverter"><option>Keep</option><option>Change</option></select>
      <span class="wrap"><select aria-label="Covered select" id="covered-select"><option>A</option><option>B</option></select><span class="veil"></span></span>
      <select aria-label="Listbox select" id="listbox-select" size="2"><option>X</option><option>Y</option></select>
    </section>
    <section id="submit-area">
      <form id="search-form"><input aria-label="Search query" id="q"></form>
      <form id="required-form"><input aria-label="Required field" id="req" required></form>
      <form id="shadowed-form"><input type="hidden" name="noValidate"><input type="hidden" name="requestSubmit"><input type="hidden" name="elements"><input aria-label="Shadowed query" id="sq"></form>
      <form id="custom-form"><input aria-label="Custom form field" id="cf"><x-ctl></x-ctl></form>
      <form id="button-form"><input aria-label="Has button field" id="hb"><button type="submit" id="go">Go</button></form>
      <form id="image-form"><input aria-label="Image form field" id="if"><input type="image" alt="Img go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></form>
      <form id="ext-form"><input aria-label="External button field" id="eb"></form><button type="submit" form="ext-form" id="ext-go">Ext go</button>
      <form id="far-form"></form>
      <input aria-label="Remote field" id="remote" form="far-form">
      <input aria-label="Loose field" id="loose">
      <span id="shadow-form-host"></span>
      <form id="two-field-form"><input aria-label="Two field A" id="tfa"><input aria-label="Two field B" id="tfb"></form>
      <form id="select-form"><select aria-label="Form select" id="form-select"><option>S1</option></select></form>
    </section>
    <section id="key-area">
      <input aria-label="Tab start" id="tab-start"><input aria-label="Tab next" id="tab-next">
      <input aria-label="Popup trigger" id="popup-input"><span id="popup">popup</span>
      <div role="listbox" tabindex="0" aria-label="Fruits" id="listbox" data-active="0">fruits</div>
      <input aria-label="Key victim" id="key-victim"><input aria-label="Late victim" id="late-victim"><input aria-label="Key thief" id="key-thief">
      <div role="button" aria-label="Unfocusable div" id="nofocus">nofocus</div>
      <input type="number" aria-label="Quantity" id="qty" value="5">
      <input type="radio" aria-label="Radio A" id="radio-a" name="r" checked><input type="radio" aria-label="Radio B" id="radio-b" name="r">
      <input type="search" aria-label="Search box" id="searchbox" value="keep search">
      <input type="search" role="textbox" aria-label="Disguised search" id="disguised" value="keep disguised">
      <input type="number" role="textbox" aria-label="Disguised number" id="disguised-number" value="7">
      <span role="button" tabindex="0" aria-label="Delegating host" id="delegate-host"></span>
      <iframe role="button" aria-label="Frame owner" id="key-frame" src="/strict-actions-frame.html" width="60" height="20"></iframe>
    </section>
    <iframe id="child-frame" src="/strict-actions-child.html" width="300" height="30"></iframe>
    <script>
      window.eventLog = [];
      for (const type of ["input", "change", "invalid", "submit", "keydown"]) {
        document.addEventListener(type, (event) => {
          const target = event.composedPath()[0];
          const entry = { id: target.id, type, trusted: event.isTrusted };
          if (type === "submit") entry.submitter = event.submitter ? event.submitter.id : null;
          if (type === "keydown") entry.key = event.key;
          window.eventLog.push(entry);
        }, true);
      }
      // SPA 式提交：不导航，页面状态可继续断言。
      document.addEventListener("submit", (event) => event.preventDefault());
      window.focusLog = [];
      document.addEventListener("focusin", (event) => {
        window.focusLog.push(event.composedPath()[0].id);
      }, true);

      document.getElementById("shadow-form-host").attachShadow({ mode: "open" }).innerHTML =
        '<form id="shadow-image-form"><input aria-label="Shadow image field" id="sif">' +
        '<input type="image" alt="Shadow img go" src="data:image/gif;base64,R0lGODlhAQABAAAAACw="></form>' +
        '<form id="shadow-plain-form"><input aria-label="Shadow plain field" id="spf"></form>';
      // closed + delegatesFocus：focus host 实际聚焦内层 number 输入框，activeElement 被重定向成 host。
      const delegated = document.getElementById("delegate-host").attachShadow({ mode: "closed", delegatesFocus: true });
      delegated.innerHTML = '<input type="number" id="delegated-number" value="3" style="width:40px">';
      window.delegatedNumber = () => delegated.getElementById("delegated-number").value;
      const rich = document.getElementById("rich-option");
      rich.appendChild(document.createElement("b")).textContent = "Rich";
      document.getElementById("reverter").addEventListener("change", (event) => {
        event.target.selectedIndex = 0;
      });
      customElements.define("x-ctl", class extends HTMLElement {
        static formAssociated = true;
        constructor() {
          super();
          this.attachInternals();
        }
      });

      document.getElementById("popup-input").addEventListener("keydown", (event) => {
        if (event.key === "Escape") document.getElementById("popup").hidden = true;
      });
      const listbox = document.getElementById("listbox");
      listbox.addEventListener("keydown", (event) => {
        const step = { ArrowDown: 1, ArrowUp: -1 }[event.key];
        if (step) listbox.dataset.active = String(Number(listbox.dataset.active) + step);
      });
      const thief = document.getElementById("key-thief");
      // 同步改焦点：调用 A 内的焦点复核即可发现。
      document.getElementById("key-victim").addEventListener("focus", () => thief.focus());
      // 调用 A 结束后（按键之前）才改焦点：只能靠监听器记录的按键目标发现。
      document.getElementById("late-victim").addEventListener("focus", () => {
        queueMicrotask(() => thief.focus());
      });
    </script>
  </body>
</html>`],
  ["/strict-actions-frame.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Strict Actions Frame</title></head>
  <body style="margin: 0">
    <input aria-label="Framed field" id="framed" style="width:40px">
    <script>
      window.keyLog = [];
      document.addEventListener("keydown", (event) => window.keyLog.push(event.key), true);
    </script>
  </body>
</html>`],
  ["/strict-actions-child.html", `<!doctype html>
<html>
  <head><meta charset="utf-8"><title>Strict Actions Child</title></head>
  <body style="margin: 2px">
    <input aria-label="Child A" id="child-a"><input aria-label="Child B" id="child-b">
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

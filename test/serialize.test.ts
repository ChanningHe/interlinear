import { beforeEach, describe, expect, test } from "vitest";
import { deserialize, serialize } from "../src/content/serialize";

function nodesOf(html: string): Node[] {
  document.body.innerHTML = `<p id="root">${html}</p>`;
  return [...document.getElementById("root")!.childNodes];
}

function render(frag: DocumentFragment): string {
  const div = document.createElement("div");
  div.append(frag);
  return div.innerHTML;
}

beforeEach(() => {
  document.body.innerHTML = "";
});

describe("serialize", () => {
  test("plain text collapses whitespace", () => {
    expect(serialize(nodesOf("  Hello \n  world  ")).text).toBe("Hello world");
  });

  test("inline formatting becomes paired placeholders", () => {
    const { text } = serialize(nodesOf('Read <a href="/x">the <b>docs</b></a> now'));
    expect(text).toBe("Read <g1>the <g2>docs</g2></g1> now");
  });

  test("code, images and notranslate become atomic placeholders", () => {
    const { text } = serialize(nodesOf('Run <code>npm i</code> <img src="a.png"> <span class="notranslate">Foo</span>.'));
    expect(text).toBe("Run <x1/> <x2/>.");
  });

  test("icons are left out of the translation instead of being copied", () => {
    expect(serialize(nodesOf('<i class="icon"></i> Settings')).text).toBe("Settings");
    expect(serialize(nodesOf('<a href="/"><svg><path d="M0 0"/></svg>Home</a>')).text).toBe("<g1>Home</g1>");
    expect(serialize(nodesOf('<a href="/"><img src="logo.png" alt="Logo"></a> Docs')).text).toBe("Docs");
    expect(serialize(nodesOf('Nice <img src="e.png" alt="😀"> work <img src="x.png" alt="×">')).text).toBe("Nice 😀 work");
  });
});

describe("deserialize", () => {
  test("rebuilds links with original attributes around translated text", () => {
    const { tokens } = serialize(nodesOf('Read <a href="/x" id="dup">the <b>docs</b></a> now'));
    const out = render(deserialize("现在阅读<g1><g2>文档</g2></g1>", tokens));
    expect(out).toBe('现在阅读<a href="/x"><b>文档</b></a>');
  });

  test("atomic placeholders are restored verbatim", () => {
    const { tokens } = serialize(nodesOf("Run <code>npm i</code> first"));
    expect(render(deserialize("先运行 <x1/>", tokens))).toBe("先运行 <code>npm i</code>");
  });

  test("model-produced HTML is treated as text, never parsed", () => {
    const { tokens } = serialize(nodesOf("hello"));
    const frag = deserialize('<img src=x onerror="alert(1)"><script>bad()</script>', tokens);
    expect(frag.querySelector("img,script")).toBeNull();
    expect(frag.textContent).toBe('<img src=x onerror="alert(1)"><script>bad()</script>');
  });

  test("tolerates unknown ids, stray closers and unclosed tags", () => {
    const { tokens } = serialize(nodesOf("<b>bold</b> text"));
    expect(render(deserialize("</g1><g9>x</g9> <g1>粗体 文本", tokens))).toBe("x <b>粗体 文本</b>");
  });

  test("never deep-clones subtrees with form fields, frames or custom elements", () => {
    const { text } = serialize(
      nodesOf(
        'A <span class="notranslate"><input name="csrf" value="t"></span> B <span translate="no"><iframe src="/x"></iframe></span> ' +
          'C <span class="notranslate"><my-widget>w</my-widget></span> D <code>ok</code>',
      ),
    );
    expect(text).toBe("A B C D <x1/>");
  });

  test("strips inline handlers and form wiring from clones", () => {
    const { tokens } = serialize(nodesOf('<a href="/x" onclick="steal()" name="n" tabindex="1">go</a> <code onmouseover="x()">c</code>'));
    const out = render(deserialize("<g1>去</g1> <x2/>", tokens));
    expect(out).toBe('<a href="/x">去</a> <code>c</code>');
  });

  test("custom inline elements become spans instead of re-running their constructors", () => {
    const { tokens } = serialize(nodesOf('<fancy-link class="k">Hello</fancy-link> world'));
    expect(render(deserialize("<g1>你好</g1> 世界", tokens))).toBe('<span class="k">你好</span> 世界');
  });

  test("literal placeholder look-alikes in page text are escaped", () => {
    const { text, tokens } = serialize(nodesOf("Type <code>x</code> then &lt;x1/&gt; literally"));
    expect(text).toBe("Type <x1/> then ‹x1/> literally");
    expect(render(deserialize(text, tokens))).toBe("Type <code>x</code> then ‹x1/&gt; literally");
  });

  test("does not inject the same atomic element twice when the model repeats it", () => {
    const { tokens } = serialize(nodesOf("<code>a</code> b"));
    expect(render(deserialize("<x1/> b <x1/>", tokens))).toBe("<code>a</code> b ");
  });
});

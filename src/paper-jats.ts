import { paperDOI, type PaperSnapshot } from "./paper-format";
import {
  paperLicense,
  paperPMCID,
  paperTextHash,
  paperTextSnapshot,
  paperXMLLimit,
  type PaperTextBlock,
} from "./paper-text-format";
const failed = () =>
  Error(
    "対応する公開本文・DOI・PMCID・利用条件をXMLで確認できません。保存済みの記録は保持しています。",
  );
const xlink = "http://www.w3.org/1999/xlink";
/** Select only direct children in the article's namespace; unrelated nested metadata cannot supply identity or rights. */
function children(parent: Element, name: string) {
  return Array.from(parent.children).filter(
    (e) => e.localName === name && e.namespaceURI === parent.namespaceURI,
  );
}
/** Require one structural node instead of guessing which of conflicting article records applies. */
function one(parent: Element, name: string) {
  const found = children(parent, name);
  if (found.length !== 1) throw failed();
  return found[0];
}
/** Keep a declared plain-text representation; no provider node or attribute is mounted into the application. */
function plain(node: Element) {
  return (node.textContent ?? "").replace(/\s+/g, " ").trim();
}
/** Strip only a standalone external article declaration without resolving it; internal entities remain refused. */
function standaloneXML(raw: string) {
  const declarations = raw.match(/<!DOCTYPE/gi) ?? [];
  if (declarations.length > 1) throw failed();
  const declaration = raw.indexOf("<!DOCTYPE");
  if (
    declaration >= 0 &&
    (declaration > raw.search(/<article(?:\s|>)/) ||
      /<\?xml(?:\s|\?>)/.test(raw.slice(declaration)))
  )
    throw failed();
  const xml = raw.replace(
    /<!DOCTYPE\s+article\s+(?:PUBLIC\s+"[^"<>[\]]{1,1024}"\s+"[^"<>[\]]{1,1024}"|SYSTEM\s+"[^"<>[\]]{1,1024}")\s*>/g,
    "",
  );
  if (/<!DOCTYPE|<!ENTITY/i.test(xml)) throw failed();
  return xml;
}
/** Bound DOM traversal after parsing a bounded entity-free document, including text/attribute-heavy inputs. */
function inspectTree(root: Element) {
  const pending: [Element, number][] = [[root, 0]];
  let count = 0;
  while (pending.length) {
    const [node, depth] = pending.pop()!;
    if (++count > 20000 || depth > 32 || node.attributes.length > 32)
      throw failed();
    for (const child of Array.from(node.children))
      pending.push([child, depth + 1]);
  }
}
/** Preserve simple inline words and sub/sup markers; unsupported formula/media paragraphs are explicitly omitted. */
function paragraph(node: Element): string | null {
  const accepted = new Set([
    "italic",
    "bold",
    "underline",
    "monospace",
    "sc",
    "sub",
    "sup",
    "xref",
    "ext-link",
    "named-content",
    "styled-content",
    "break",
  ]);
  function text(current: Element): string | null {
    let value = "";
    for (const child of Array.from(current.childNodes)) {
      if (
        child.nodeType === Node.TEXT_NODE ||
        child.nodeType === Node.CDATA_SECTION_NODE
      )
        value += child.textContent ?? "";
      else if (child.nodeType === Node.ELEMENT_NODE) {
        const element = child as Element;
        if (
          element.namespaceURI !== node.namespaceURI ||
          !accepted.has(element.localName)
        )
          return null;
        const nested = text(element);
        if (nested === null) return null;
        value +=
          element.localName === "sub"
            ? `_{${nested}}`
            : element.localName === "sup"
              ? `^{${nested}}`
              : element.localName === "break"
                ? " "
                : nested;
      }
    }
    return value;
  }
  return text(node)?.replace(/\s+/g, " ").trim() ?? null;
}
/** Read one supported, unscoped article grant and retain its complete supplied statement for attribution. */
function license(meta: Element) {
  const permissions = one(meta, "permissions"),
    licenses = children(permissions, "license");
  if (licenses.length !== 1) throw failed();
  const grant = licenses[0],
    urls: string[] = [];
  if (
    ["specific-use", "start_date", "end_date", "applies_to"].some((a) =>
      grant.hasAttribute(a),
    ) ||
    (grant.hasAttribute("license-type") &&
      !["open-access", "cc-by", "cc0"].includes(
        grant.getAttribute("license-type")!,
      ))
  )
    throw failed();
  const href = grant.getAttributeNS(xlink, "href");
  if (href) urls.push(href);
  for (const child of Array.from(grant.getElementsByTagName("*"))) {
    if (
      child.localName === "license_ref" &&
      child.namespaceURI === "http://www.niso.org/schemas/ali/1.0/"
    ) {
      if (
        ["start_date", "end_date", "applies_to"].some((a) =>
          child.hasAttribute(a),
        )
      )
        throw failed();
      urls.push((child.textContent ?? "").trim());
    } else if (
      child.localName === "ext-link" &&
      child.namespaceURI === meta.namespaceURI
    ) {
      const link = child.getAttributeNS(xlink, "href");
      if (link && /^https?:\/\/(?:www\.)?creativecommons\.org\//.test(link))
        urls.push(link);
    }
  }
  if (!urls.length) throw failed();
  const recognized = urls.map(paperLicense);
  if (new Set(recognized).size !== 1) throw failed();
  return {
    url: recognized[0],
    statement: plain(grant),
    copyright: children(permissions, "copyright-statement")
      .map(plain)
      .join("\n"),
  };
}
/** Bind a manually retrieved JATS body to its exact PMCID/DOI, declared grant and captured bibliographic observation. */
export async function parsePaperJATS(
  raw: string,
  input: string,
  paper: PaperSnapshot,
  capturedAt = new Date().toISOString(),
) {
  try {
    if (!raw || new TextEncoder().encode(raw).byteLength > paperXMLLimit)
      throw failed();
    const pmcid = paperPMCID(input),
      doc = new DOMParser().parseFromString(standaloneXML(raw), "text/xml"),
      article = doc.documentElement;
    if (
      doc.doctype ||
      !article ||
      article.localName !== "article" ||
      doc.getElementsByTagName("parsererror").length
    )
      throw failed();
    inspectTree(article);
    const meta = one(one(article, "front"), "article-meta"),
      ids = children(meta, "article-id");
    const dois = ids
        .filter((e) => e.getAttribute("pub-id-type") === "doi")
        .map((e) => paperDOI(plain(e))),
      pmcids = ids
        .filter((e) =>
          ["pmc", "pmcid"].includes(e.getAttribute("pub-id-type") ?? ""),
        )
        .map((e) => {
          const id = plain(e);
          return paperPMCID(/^\d+$/.test(id) ? "PMC" + id : id);
        });
    if (
      !dois.length ||
      new Set(dois).size !== 1 ||
      dois[0] !== paper.metadata.doi ||
      !pmcids.length ||
      pmcids.some((id) => id !== pmcid)
    )
      throw failed();
    const grant = license(meta),
      titleGroup = children(meta, "title-group"),
      titles = titleGroup
        .flatMap((g) => children(g, "article-title"))
        .map(plain),
      versionNodes = children(meta, "article-version"),
      versions = versionNodes.map(plain);
    if (titles.length > 1 || versions.length > 1) throw failed();
    const authors = children(meta, "contrib-group")
      .flatMap((group) => children(group, "contrib"))
      .filter((c) => c.getAttribute("contrib-type") === "author")
      .map((c) => {
        const named = children(c, "name");
        return named.length === 1
          ? [
              children(named[0], "given-names").map(plain).join(" "),
              children(named[0], "surname").map(plain).join(" "),
            ]
              .filter(Boolean)
              .join(" ")
          : children(c, "collab").map(plain).join(" / ");
      })
      .filter(Boolean);
    const body = one(article, "body"),
      blocks: PaperTextBlock[] = [];
    let omitted = 0;
    const excluded = new Set([
      "fig",
      "table-wrap",
      "table-wrap-group",
      "disp-formula",
      "disp-formula-group",
      "supplementary-material",
      "media",
      "graphic",
      "inline-graphic",
      "preformat",
      "code",
    ]);
    /** Retain structural sibling indexes and ancestor headings so an excerpt names one immutable source location. */
    function walk(parent: Element, path: string, sections: string[]) {
      const counts = new Map<string, number>();
      for (const child of Array.from(parent.children)) {
        const name = child.localName,
          index = (counts.get(name) ?? 0) + 1;
        counts.set(name, index);
        if (child.namespaceURI !== article.namespaceURI || excluded.has(name)) {
          omitted++;
          continue;
        }
        if (name === "title") continue;
        const location = `${path}/${name}[${index}]`;
        if (name === "p") {
          const text = paragraph(child);
          if (text === null) omitted++;
          else if (text) blocks.push({ path: location, sections, text });
        } else {
          const heading =
            name === "sec"
              ? children(child, "title").map(plain).filter(Boolean)
              : [];
          walk(child, location, [...sections, ...heading]);
        }
      }
    }
    walk(body, "/article[1]/body[1]", []);
    return await paperTextSnapshot(
      paper,
      {
        pmcid,
        doi: dois[0],
        title: titles[0] || null,
        authors,
        articleType: article.getAttribute("article-type"),
        version: versions[0] || null,
        ...(versionNodes[0]?.hasAttribute("article-version-type")
          ? {
              versionType: versionNodes[0].getAttribute(
                "article-version-type",
              )!,
            }
          : {}),
        license: grant,
        xmlTextDigest: await paperTextHash(raw),
        blocks,
        omitted,
      },
      capturedAt,
    );
  } catch {
    throw failed();
  }
}

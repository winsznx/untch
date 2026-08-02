import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
  battleCardManifestEntries,
  buildBattleCard,
  contentHashOf,
  DEFAULT_ARCHIVE_LIMITS,
  evaluateManifest,
  extractClaims,
  findOwnedService,
  InMemoryArtifactStorage,
  activate,
  manifestHashOf,
  mayRead,
  publishedHeadersFor,
  readArtifactVersion,
  renderBattleCardHtml,
  rollback,
  serveMimeFor,
  validateArchive,
  writeArtifactVersion,
  type Artifact,
  type ArchiveEntry,
  type FetchedPage,
  type ResolvedSide,
  type Site,
  type SiteRelease,
} from "../src/index";

const NOW = "2026-08-02T12:00:00.000Z";
const enc = new TextEncoder();

/**
 * Assert on the CODE, not on the message.
 *
 * A code is the contract a caller branches on; a message is prose that will be reworded. Matching the
 * message would make every refusal test a hostage to its own wording.
 */
const hasCode = (code: string) => (err: unknown): boolean => {
  assert.equal((err as { code?: string }).code, code);
  return true;
};

// ─────────────────────────────────────────────────────────────────────────────
// artifacts
// ─────────────────────────────────────────────────────────────────────────────

describe("an artifact version is a fact about bytes, not a claim about them", () => {
  test("the content hash is computed from what is stored, never taken from the caller", async () => {
    // #given bytes and a storage
    const storage = new InMemoryArtifactStorage();
    const bytes = enc.encode("<html>hello</html>");

    // #when a version is written
    const version = await writeArtifactVersion(storage, {
      artifactId: "art_1",
      accountId: "acct_1",
      versionId: "av_1",
      bytes,
      mimeType: "text/html",
      sourceNodeId: null,
      createdAt: NOW,
    });

    // #then the hash equals the hash of the bytes
    assert.equal(version.contentHash, contentHashOf(bytes));
    assert.equal(version.sizeBytes, bytes.byteLength);
  });

  test("identical bytes from one account occupy one object", async () => {
    const storage = new InMemoryArtifactStorage();
    const bytes = enc.encode("same");
    const common = { accountId: "acct_1", bytes, mimeType: "application/json" as const, sourceNodeId: null, createdAt: NOW };
    const a = await writeArtifactVersion(storage, { ...common, artifactId: "art_a", versionId: "av_a" });
    const b = await writeArtifactVersion(storage, { ...common, artifactId: "art_b", versionId: "av_b" });

    assert.equal(a.storageKey, b.storageKey, "content-addressed, so one object");
    assert.equal(storage.size, 1);
    assert.notEqual(a.versionId, b.versionId, "two versions still exist as separate rows");
  });

  test("two accounts with identical bytes do not share an object", async () => {
    const storage = new InMemoryArtifactStorage();
    const bytes = enc.encode("same");
    const common = { bytes, mimeType: "application/json" as const, sourceNodeId: null, createdAt: NOW, artifactId: "art", versionId: "av" };
    const a = await writeArtifactVersion(storage, { ...common, accountId: "acct_a" });
    const b = await writeArtifactVersion(storage, { ...common, accountId: "acct_b" });
    assert.notEqual(a.storageKey, b.storageKey);
  });

  test("a read re-hashes, so a silently truncated object is not served as valid", async () => {
    const storage = new InMemoryArtifactStorage();
    const version = await writeArtifactVersion(storage, {
      artifactId: "art_1",
      accountId: "acct_1",
      versionId: "av_1",
      bytes: enc.encode("original"),
      mimeType: "text/markdown",
      sourceNodeId: null,
      createdAt: NOW,
    });

    // #when the backend loses bytes behind the platform's back
    await storage.put(version.storageKey, enc.encode("tampered"), "text/markdown");

    // #then the read refuses rather than returning content the version never committed to
    await assert.rejects(() => readArtifactVersion(storage, version), hasCode("ARTIFACT_HASH_MISMATCH"));
  });

  test("an empty artifact is refused: a renderer that produced nothing must fail loudly", async () => {
    const storage = new InMemoryArtifactStorage();
    await assert.rejects(
      () =>
        writeArtifactVersion(storage, {
          artifactId: "art_1",
          accountId: "acct_1",
          versionId: "av_1",
          bytes: new Uint8Array(0),
          mimeType: "text/html",
          sourceNodeId: null,
          createdAt: NOW,
        }),
      hasCode("ARTIFACT_EMPTY"),
    );
  });

  test("an unsupported media type is refused rather than stored with a fallback", async () => {
    const storage = new InMemoryArtifactStorage();
    await assert.rejects(
      () =>
        writeArtifactVersion(storage, {
          artifactId: "art_1",
          accountId: "acct_1",
          versionId: "av_1",
          bytes: enc.encode("MZ"),
          mimeType: "application/x-msdownload",
          sourceNodeId: null,
          createdAt: NOW,
        }),
      hasCode("ARTIFACT_MIME_UNSUPPORTED"),
    );
  });

  test("PDF is not claimed, because nothing here renders one", () => {
    // The registry must not offer a format the platform cannot produce.
    const battleCard = findOwnedService("untch", "battle_card");
    assert.ok(battleCard);
    assert.equal(
      battleCard.outputContract.some((e) => e.mimeType === "application/pdf"),
      false,
      "no owned service may promise a PDF while no renderer exists",
    );
  });
});

describe("who may read an artifact", () => {
  const base: Artifact = {
    artifactId: "art_1",
    accountId: "acct_owner",
    orderId: null,
    type: "battle-card",
    visibility: "PRIVATE",
    currentVersionId: "av_1",
    createdAt: NOW,
    retentionUntil: null,
    status: "ACTIVE",
  };

  test("a private artifact is readable only by its account", () => {
    assert.equal(mayRead(base, "acct_owner"), true);
    assert.equal(mayRead(base, "acct_other"), false);
    assert.equal(mayRead(base, null), false);
  });

  test("a public artifact is readable by anyone, signed in or not", () => {
    const pub = { ...base, visibility: "PUBLIC" as const };
    assert.equal(mayRead(pub, null), true);
    assert.equal(mayRead(pub, "acct_other"), true);
  });

  test("retention beats ownership: an expired artifact is readable by nobody, including its owner", () => {
    // An owner-only exception would make the retention promise optional in the one case that matters.
    assert.equal(mayRead({ ...base, status: "EXPIRED" }, "acct_owner"), false);
    assert.equal(mayRead({ ...base, status: "DELETED", visibility: "PUBLIC" }, "acct_owner"), false);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// archives
// ─────────────────────────────────────────────────────────────────────────────

const file = (path: string, over: Partial<ArchiveEntry> = {}): ArchiveEntry => ({
  path,
  type: "file",
  declaredSize: 1024,
  compressedSize: 512,
  ...over,
});

const withIndex = (...entries: ArchiveEntry[]): ArchiveEntry[] => [file("index.html"), ...entries];

function codes(entries: readonly ArchiveEntry[]): string[] {
  const verdict = validateArchive(entries);
  return verdict.ok ? [] : verdict.refusals.map((r) => r.code);
}

describe("an archive is judged before anything is written", () => {
  test("a clean archive passes and names its entrypoint", () => {
    const verdict = validateArchive(withIndex(file("assets/app.css"), file("assets/logo.svg")));
    assert.equal(verdict.ok, true);
    if (!verdict.ok) return;
    assert.equal(verdict.entrypoint, "index.html");
    assert.equal(verdict.files.length, 3);
    assert.equal(verdict.totalBytes, 3072);
  });

  test("path traversal is refused", () => {
    assert.ok(codes(withIndex(file("../../etc/passwd"))).includes("ARCHIVE_PATH_TRAVERSAL"));
    assert.ok(codes(withIndex(file("a/b/../../../out.txt"))).includes("ARCHIVE_PATH_TRAVERSAL"));
  });

  test("absolute paths are refused, on both path grammars", () => {
    assert.ok(codes(withIndex(file("/etc/passwd"))).includes("ARCHIVE_ABSOLUTE_PATH"));
    assert.ok(codes(withIndex(file("C:\\Windows\\system32\\x.txt"))).includes("ARCHIVE_ABSOLUTE_PATH"));
  });

  test("links are refused by type, not by target", () => {
    // The target could be inside the tree and it would still be refused: a target can move after the
    // check, and the check is the only moment this code gets to look.
    assert.ok(codes(withIndex(file("link.html", { type: "symlink" }))).includes("ARCHIVE_SYMLINK"));
    assert.ok(codes(withIndex(file("hard.html", { type: "hardlink" }))).includes("ARCHIVE_HARDLINK"));
  });

  test("a decompression bomb is caught per entry, before any size total is exceeded", () => {
    // 10 MB from 1 KB: every total-size check would pass on the way in.
    const bomb = file("bomb.txt", { declaredSize: 10_000_000, compressedSize: 1_000 });
    assert.ok(codes(withIndex(bomb)).includes("ARCHIVE_DECOMPRESSION_BOMB"));
  });

  test("an unknown extension is refused rather than served by a sniffer's guess", () => {
    assert.ok(codes(withIndex(file("thing.xyz"))).includes("ARCHIVE_MIME_UNSUPPORTED"));
  });

  test("server-executable extensions are refused", () => {
    for (const path of ["shell.php", "script.py", "run.sh", "mod.wasm"]) {
      assert.ok(codes(withIndex(file(path))).includes("ARCHIVE_EXECUTABLE"), `${path} must be refused`);
    }
  });

  test("credential and history files are refused at any depth", () => {
    assert.ok(codes(withIndex(file(".env"))).includes("ARCHIVE_SECRET_FILE"));
    assert.ok(codes(withIndex(file("nested/deep/.env.production"))).includes("ARCHIVE_SECRET_FILE"));
    assert.ok(codes(withIndex(file(".git/config"))).includes("ARCHIVE_SECRET_FILE"));
  });

  test("too many files, or too many bytes, is refused", () => {
    const many = Array.from({ length: DEFAULT_ARCHIVE_LIMITS.maxFileCount + 1 }, (_, i) => file(`f${i}.txt`));
    assert.ok(codes(withIndex(...many)).includes("ARCHIVE_TOO_MANY_FILES"));

    const heavy = Array.from({ length: 8 }, (_, i) =>
      file(`big${i}.txt`, { declaredSize: 9_000_000, compressedSize: 4_000_000 }),
    );
    assert.ok(codes(withIndex(...heavy)).includes("ARCHIVE_TOO_LARGE"));
  });

  test("no index.html is refused: a site with no entry point has nothing to serve", () => {
    assert.ok(codes([file("about.html")]).includes("ARCHIVE_NO_ENTRYPOINT"));
    assert.ok(codes([]).includes("ARCHIVE_EMPTY"));
  });

  test("every refusal is collected, so one upload is fixed once rather than four times", () => {
    const found = codes([file("../a.html"), file("b.php"), file(".env"), file("c.xyz")]);
    for (const code of ["ARCHIVE_PATH_TRAVERSAL", "ARCHIVE_EXECUTABLE", "ARCHIVE_SECRET_FILE", "ARCHIVE_MIME_UNSUPPORTED"]) {
      assert.ok(found.includes(code), `${code} was swallowed by an earlier refusal`);
    }
  });
});

describe("published files are served on this host's terms", () => {
  test("the media type comes from a table, and nosniff makes the table binding", () => {
    assert.equal(serveMimeFor("index.html"), "text/html");
    assert.equal(serveMimeFor("thing.xyz"), null);
    const headers = publishedHeadersFor("index.html", `0x${"ab".repeat(32)}`);
    assert.equal(headers["content-type"], "text/html");
    assert.equal(headers["x-content-type-options"], "nosniff");
  });

  test("the CSP forbids script and framing outright", () => {
    const csp = publishedHeadersFor("index.html", `0x${"ab".repeat(32)}`)["content-security-policy"] ?? "";
    assert.match(csp, /default-src 'none'/);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.equal(csp.includes("script-src"), false, "no script source is permitted at all");
  });
});

describe("activation is a pointer move, so rollback needs no re-upload", () => {
  const site: Site = {
    siteId: "site_1",
    accountId: "acct_1",
    orderId: null,
    slug: "card",
    activeReleaseId: null,
    status: "ACTIVE",
    retentionUntil: null,
  };
  const release = (id: string, status: SiteRelease["status"]): SiteRelease => ({
    releaseId: id,
    siteId: "site_1",
    sourceArtifactId: "art_1",
    sourceZipHash: `0x${"11".repeat(32)}`,
    extractedManifestHash: `0x${"22".repeat(32)}`,
    fileCount: 1,
    totalSize: 100,
    entrypoint: "index.html",
    createdAt: NOW,
    activatedAt: null,
    status,
  });

  test("activating a READY release moves the pointer and stamps the release", () => {
    const result = activate(site, release("rel_1", "READY"), NOW);
    assert.equal(result.site.activeReleaseId, "rel_1");
    assert.equal(result.release.status, "ACTIVE");
    assert.equal(result.release.activatedAt, NOW);
  });

  test("a release that failed validation cannot be activated", () => {
    assert.throws(() => activate(site, release("rel_bad", "REJECTED"), NOW), /only a validated release/);
    assert.throws(() => activate(site, release("rel_pending", "VALIDATING"), NOW), /only a validated release/);
  });

  test("a release belonging to another site is refused", () => {
    const foreign = { ...release("rel_x", "READY"), siteId: "site_other" };
    assert.throws(() => activate(site, foreign, NOW), /belongs to site/);
  });

  test("rollback returns to a previous release without re-uploading it", () => {
    const first = release("rel_1", "READY");
    const live = activate(site, first, NOW);
    const second = activate(live.site, release("rel_2", "READY"), NOW);
    assert.equal(second.site.activeReleaseId, "rel_2");

    const back = rollback(second.site, live.release, NOW);
    assert.equal(back.site.activeReleaseId, "rel_1");
    assert.equal(back.release.status, "ACTIVE");
  });

  test("the manifest hash is order-independent over the same files", () => {
    const a = manifestHashOf([
      { path: "index.html", contentHash: `0x${"aa".repeat(32)}` },
      { path: "app.css", contentHash: `0x${"bb".repeat(32)}` },
    ]);
    const b = manifestHashOf([
      { path: "app.css", contentHash: `0x${"bb".repeat(32)}` },
      { path: "index.html", contentHash: `0x${"aa".repeat(32)}` },
    ]);
    assert.equal(a, b);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// battle card
// ─────────────────────────────────────────────────────────────────────────────

const PRODUCT_HTML = `<html><head><title>Kyrve — bounded agent spend</title>
<meta name="description" content="Kyrve checks every payment before it moves."></head>
<body><h1>The model never touches the money.</h1>
<h2>Deterministic decisions</h2><h2>Verifiable receipts</h2>
<p>Encryption at rest. Plans from $40 per month.</p></body></html>`;

const COMPETITOR_HTML = `<html><head><title>Rivalpay — agent payments</title>
<meta name="description" content="Rivalpay is the open-source way to pay agents."></head>
<body><h1>Payments for agents, free to start.</h1>
<h2>Self-hosted</h2><h2>SOC 2 compliant</h2>
<p>Free tier available. Enterprise from $199/month.</p></body></html>`;

function page(url: string, html: string): FetchedPage {
  return { url, status: 200, html, observedAt: NOW };
}

function sides(): { product: ResolvedSide; competitor: ResolvedSide } {
  return {
    product: { label: "Kyrve", url: "https://kyrve.example", page: page("https://kyrve.example", PRODUCT_HTML), unavailableReason: null },
    competitor: {
      label: "Rivalpay",
      url: "https://rivalpay.example",
      page: page("https://rivalpay.example", COMPETITOR_HTML),
      unavailableReason: null,
    },
  };
}

function card() {
  const { product, competitor } = sides();
  const claims = [
    ...extractClaims(product.page!, "prod", "n1", "ord_1"),
    ...extractClaims(competitor.page!, "comp", "n2", "ord_1"),
  ];
  return buildBattleCard({
    input: { product: "https://kyrve.example", competitor: "https://rivalpay.example" },
    product,
    competitor,
    claims,
    generatedAt: NOW,
  });
}

describe("every claim on a battle card carries where it came from", () => {
  test("extraction produces vendor-published claims with a source, a date and an extract hash", () => {
    const claims = extractClaims(page("https://kyrve.example", PRODUCT_HTML), "prod", "n1", "ord_1");
    assert.ok(claims.length > 0);
    for (const c of claims) {
      assert.equal(c.sourceType, "VENDOR_PUBLISHED");
      assert.equal(c.sourceRef, "https://kyrve.example");
      assert.equal(c.observedAt, NOW);
      assert.ok(c.extractHash, "a disputed row must be checkable against the bytes that produced it");
      assert.ok(c.freshUntil, "marketing pages change; a card without a recheck date ages silently");
    }
  });

  test("a price string is MEDIUM and says its context was not read", () => {
    const claims = extractClaims(page("https://kyrve.example", PRODUCT_HTML), "prod", "n1", "ord_1");
    const prices = claims.filter((c) => c.statement.startsWith("Price string published"));
    assert.ok(prices.length > 0, "the page does publish a price string");
    for (const p of prices) {
      assert.equal(p.confidence, "MEDIUM", "a currency string is never HIGH confidence");
      assert.match(p.statement, /confirm before quoting/);
    }
  });

  test("a page with no price produces no pricing claim and an explicit gap", () => {
    const noPrice = `<html><head><title>Quiet</title></head><body><h1>No numbers here</h1></body></html>`;
    const { competitor } = sides();
    const product: ResolvedSide = {
      label: "Quiet",
      url: "https://quiet.example",
      page: page("https://quiet.example", noPrice),
      unavailableReason: null,
    };
    const claims = extractClaims(product.page!, "prod", "n1", "ord_1");
    assert.equal(
      claims.some((c) => c.statement.startsWith("Price string published")),
      false,
      "no price on the page means no pricing claim — not a guessed one",
    );

    const built = buildBattleCard({
      input: { product: "https://quiet.example", competitor: "https://rivalpay.example" },
      product,
      competitor: { ...competitor, page: null, unavailableReason: "not read" },
      claims,
      generatedAt: NOW,
    });
    const pricing = built.sections.find((s) => s.heading === "Published pricing");
    assert.equal(pricing?.rows.length, 0);
    assert.match(pricing?.gap ?? "", /Do not state a price/);
  });

  test("asymmetry rows are DERIVED, LOW, and say they are about pages rather than products", () => {
    const built = card();
    const asym = built.sections.filter((s) => s.heading.startsWith("Where "));
    const rows = asym.flatMap((s) => s.rows);
    assert.ok(rows.length > 0);
    for (const r of rows) {
      assert.equal(r.sourceType, "DERIVED");
      assert.equal(r.confidence, "LOW");
      assert.match(r.text, /not evidence of a difference in capability/);
    }
  });

  test("the section no extractor can fill is a gap, not a sentence", () => {
    const built = card();
    const neither = built.sections.find((s) => s.heading === "Where neither of you fits");
    assert.equal(neither?.rows.length, 0);
    assert.match(neither?.gap ?? "", /needs a human/);
  });

  test("the limitations are on the card, and say no model wrote a row", () => {
    const built = card();
    assert.ok(built.limitations.some((l) => /No model wrote any row/.test(l)));
    assert.ok(built.limitations.some((l) => /they say it, not that it is true/.test(l)));
  });
});

describe("the HTML and the JSON are projections of the same rows", () => {
  test("every claim in the JSON appears in the rendered HTML", () => {
    const built = card();
    const html = renderBattleCardHtml(built);
    for (const c of built.claims) {
      assert.ok(html.includes(c.claimId), `claim ${c.claimId} is exported but not rendered`);
    }
  });

  test("every section heading in the JSON appears in the HTML", () => {
    const built = card();
    const html = renderBattleCardHtml(built);
    for (const s of built.sections) {
      assert.ok(html.includes(s.heading), `section "${s.heading}" is exported but not rendered`);
    }
  });

  test("the HTML is self-contained: no remote asset, no script", () => {
    const html = renderBattleCardHtml(card());
    assert.equal(/<script/i.test(html), false, "a published card runs nothing");
    assert.equal(/src\s*=\s*["']https?:/i.test(html), false, "no remote image or asset");
    assert.equal(/<link[^>]+stylesheet/i.test(html), false, "the stylesheet is inline; the CSP forbids external ones");
    assert.equal(/gradient/i.test(html), false);
  });

  test("outbound links carry rel protections and only http(s) survives", () => {
    const built = card();
    const html = renderBattleCardHtml(built);
    for (const m of html.matchAll(/<a href="([^"]+)"([^>]*)>/g)) {
      assert.match(m[1] as string, /^https?:\/\//, "only http(s) hrefs are rendered");
      assert.match(m[2] as string, /noopener/);
      assert.match(m[2] as string, /noreferrer/);
    }
  });

  test("a hostile page cannot inject markup into the card", () => {
    const hostile = `<html><head><title>Evil"><script>alert(1)</script></title></head><body><h1>x</h1></body></html>`;
    const { competitor } = sides();
    const product: ResolvedSide = {
      label: "Evil",
      url: "https://evil.example",
      page: page("https://evil.example", hostile),
      unavailableReason: null,
    };
    const claims = extractClaims(product.page!, "prod", "n1", "ord_1");
    const html = renderBattleCardHtml(
      buildBattleCard({
        input: { product: "https://evil.example", competitor: "https://rivalpay.example" },
        product,
        competitor,
        claims,
        generatedAt: NOW,
      }),
    );
    assert.equal(/<script>alert/i.test(html), false, "the extracted title must be escaped, not executed");
  });

  test("a side that could not be read makes the card say so rather than compare against nothing", () => {
    const { product } = sides();
    const built = buildBattleCard({
      input: { product: "https://kyrve.example", competitor: "https://unreachable.example" },
      product,
      competitor: { label: "Unreachable", url: "https://unreachable.example", page: null, unavailableReason: "HTTP 403" },
      claims: extractClaims(product.page!, "prod", "n1", "ord_1"),
      generatedAt: NOW,
    });
    assert.equal(built.competitor.reachable, false);
    assert.match(built.sections.find((s) => s.heading === "How they position themselves")?.gap ?? "", /Nothing was read/);
    assert.ok(built.limitations.some((l) => /one-sided/.test(l)));
  });
});

describe("the delivery manifest is graded from the artifact rows", () => {
  test("all four files present is PASS", () => {
    const produced = ["battle-card.html", "battle-card.json", "evidence.json", "delivery-manifest.json"].map((name, i) => ({
      name,
      mimeType: name.endsWith(".html") ? "text/html" : "application/json",
      artifactId: `art_${i}`,
      versionId: `av_${i}`,
      contentHash: `0x${String(i).repeat(64)}` as const,
      sizeBytes: 100,
    }));
    const entries = battleCardManifestEntries(produced);
    assert.equal(entries.every((e) => e.present), true);
    assert.equal(evaluateManifest(entries), "PASS");
  });

  test("a promised file that was never written is PARTIAL, and the row says present: false", () => {
    const entries = battleCardManifestEntries([
      {
        name: "battle-card.html",
        mimeType: "text/html",
        artifactId: "art_0",
        versionId: "av_0",
        contentHash: `0x${"aa".repeat(32)}`,
        sizeBytes: 100,
      },
    ]);
    assert.equal(evaluateManifest(entries), "PARTIAL");
    const missing = entries.find((e) => e.name === "evidence.json");
    assert.equal(missing?.present, false);
    assert.equal(missing?.contentHash, null, "a file that was not written has no hash to report");
  });

  test("nothing written at all is FAIL, never a quiet PASS", () => {
    assert.equal(evaluateManifest(battleCardManifestEntries([])), "FAIL");
  });

  test("a contract that promised nothing is FAIL, because reporting PASS would hide the bug", () => {
    assert.equal(evaluateManifest([]), "FAIL");
  });
});

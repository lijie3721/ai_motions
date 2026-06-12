import { mkdir, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const outPath = process.argv[2] || "/tmp/ai-motions-fixture.pptx";
const tempDir = "/tmp/ai-motions-fixture-pptx";

await rm(tempDir, { recursive: true, force: true });
await mkdir(path.join(tempDir, "_rels"), { recursive: true });
await mkdir(path.join(tempDir, "ppt/slides"), { recursive: true });
await mkdir(path.join(tempDir, "ppt/_rels"), { recursive: true });

await writeFile(path.join(tempDir, "[Content_Types].xml"), `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/ppt/presentation.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"/>
  <Override PartName="/ppt/slides/slide1.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
  <Override PartName="/ppt/slides/slide2.xml" ContentType="application/vnd.openxmlformats-officedocument.presentationml.slide+xml"/>
</Types>`);

await writeFile(path.join(tempDir, "_rels/.rels"), `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="ppt/presentation.xml"/>
</Relationships>`);

await writeFile(path.join(tempDir, "ppt/presentation.xml"), `<?xml version="1.0" encoding="UTF-8"?>
<p:presentation xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main">
  <p:sldIdLst>
    <p:sldId id="256"/>
    <p:sldId id="257"/>
  </p:sldIdLst>
</p:presentation>`);

await writeFile(path.join(tempDir, "ppt/slides/slide1.xml"), slideXml("Q2 Revenue Review", [
  "Revenue grew 18 percent year over year.",
  "North America and Enterprise accounts led the quarter.",
]));
await writeFile(path.join(tempDir, "ppt/slides/slide2.xml"), slideXml("Next Quarter Focus", [
  "Improve conversion in mid-market pipeline.",
  "Launch customer success playbooks for expansion.",
]));

await rm(outPath, { force: true });
await execFileAsync("zip", ["-qr", outPath, "."], { cwd: tempDir });
console.log(outPath);

function slideXml(title, lines) {
  const textRuns = [title, ...lines].map((line) => `<a:t>${escapeXml(line)}</a:t>`).join("");
  return `<?xml version="1.0" encoding="UTF-8"?>
<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
  <p:cSld>
    <p:spTree>${textRuns}</p:spTree>
  </p:cSld>
</p:sld>`;
}

function escapeXml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

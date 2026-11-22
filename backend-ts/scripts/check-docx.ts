import { readFileSync } from "node:fs";
import { docxToMarkdown, markdownToDocx } from "../src/services/documents/docx.js";

const file = process.argv[2] ?? "/tmp/real_word.docx";
const data = new Uint8Array(readFileSync(file));
const md = docxToMarkdown(data, file);
console.log("=== docxToMarkdown output ===");
console.log(md);
console.log("=== end ===");
// round-trip sanity
const back = markdownToDocx(md, "t");
const md2 = docxToMarkdown(back, "roundtrip.docx");
console.log("=== roundtrip ===");
console.log(md2);

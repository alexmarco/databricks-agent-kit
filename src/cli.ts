#!/usr/bin/env node
import { readFileSync } from "node:fs";

const packageJson = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as { version: string };

const [command] = process.argv.slice(2);

if (command === "--version" || command === "-v") {
  process.stdout.write(`${packageJson.version}\n`);
}

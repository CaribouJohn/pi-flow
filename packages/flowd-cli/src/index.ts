#!/usr/bin/env bun
import { run } from "./cli.ts";

const { code, message } = run(process.argv.slice(2));
console.log(message);
process.exit(code);

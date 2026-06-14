#!/usr/bin/env bun
import { run } from "./cli.ts";

const { code, message } = run(process.argv.slice(2));
(code === 0 ? console.log : console.error)(message);
process.exit(code);

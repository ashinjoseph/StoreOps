/// <reference types="node" />
import { readFileSync } from "node:fs";

const dir = new URL("./", import.meta.url);

/** A fresh deep copy of a fixture, so a test may break it freely. */
export function fixture<T = any>(name: string): T {
  return JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8")) as T;
}

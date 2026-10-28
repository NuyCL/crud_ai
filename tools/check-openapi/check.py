#!/usr/bin/env python3
"""Structural sanity check for spec/openapi.yaml (needs PyYAML: pip install pyyaml).

Checks that every $ref resolves, operationIds are unique, every {path parameter}
is declared, every referenced security scheme exists, and every operation has at
least one 2xx response. It does not replace a full OpenAPI validator (for that
use e.g. `npx @redocly/cli lint spec/openapi.yaml`), but it needs no network.

    python3 tools/check-openapi/check.py [path/to/openapi.yaml]
"""
import re
import sys

import yaml

HTTP_METHODS = ("get", "put", "post", "delete", "patch", "head", "options")


def resolve(doc, ref):
    node = doc
    for part in ref.removeprefix("#/").split("/"):
        if not isinstance(node, dict) or part not in node:
            return None
        node = node[part]
    return node


def walk(node):
    """Yield every dict/list in the document."""
    yield node
    children = node.values() if isinstance(node, dict) else node if isinstance(node, list) else ()
    for child in children:
        yield from walk(child)


def main(path):
    with open(path, encoding="utf-8") as f:
        doc = yaml.safe_load(f)
    errors = []

    for key in ("openapi", "info", "paths"):
        if key not in doc:
            errors.append(f"missing top-level '{key}'")

    for node in walk(doc):
        if isinstance(node, dict) and isinstance(node.get("$ref"), str):
            if resolve(doc, node["$ref"]) is None:
                errors.append(f"unresolved $ref {node['$ref']}")

    schemes = set(doc.get("components", {}).get("securitySchemes", {}))
    seen_ids = {}
    operations = 0
    for url, item in doc.get("paths", {}).items():
        shared = item.get("parameters", [])
        for method in HTTP_METHODS:
            op = item.get(method)
            if op is None:
                continue
            operations += 1
            where = f"{method.upper()} {url}"

            op_id = op.get("operationId")
            if not op_id:
                errors.append(f"{where}: missing operationId")
            elif op_id in seen_ids:
                errors.append(f"{where}: operationId '{op_id}' also used by {seen_ids[op_id]}")
            else:
                seen_ids[op_id] = where

            declared = set()
            for p in shared + op.get("parameters", []):
                p = resolve(doc, p["$ref"]) if "$ref" in p else p
                if p and p.get("in") == "path":
                    declared.add(p["name"])
            for name in re.findall(r"{([^}]+)}", url):
                if name not in declared:
                    errors.append(f"{where}: path parameter '{name}' is not declared")

            for requirement in op.get("security", []):
                for name in requirement:
                    if name not in schemes:
                        errors.append(f"{where}: unknown security scheme '{name}'")

            if not any(str(code).startswith("2") for code in op.get("responses", {})):
                errors.append(f"{where}: no 2xx response")

    if errors:
        print(f"{path}: {len(errors)} problem(s)")
        for e in errors:
            print("  -", e)
        return 1
    print(f"{path}: ok ({len(doc['paths'])} paths, {operations} operations, {len(seen_ids)} unique operationIds)")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1] if len(sys.argv) > 1 else "spec/openapi.yaml"))

---
name: spec-ambiguity-check
description: Read spec/ as an implementer in a given language and list every point that can be interpreted more than one way, with a recommended answer and a deciding test case. Use after editing the spec and before writing tests or code.
---

# Spec ambiguity check

Usage: `/spec-ambiguity-check <language>`

1. Read all of spec/ as a developer who must implement it in <language> and cannot ask anyone.
2. List every point open to more than one interpretation (not just the top five), ordered by impact.
3. For each: the ambiguous text (file and rule), the competing readings, a recommended answer,
   and one concrete test case that would decide it.
4. Pay particular attention to: integer overflow, Unicode, missing versus null versus zero,
   type comparison, ordering, defaults and error precedence.
   Also, always ask these (they were the surprises in every earlier port):
   - Percent-encoded paths: `%2F`, `%FF`/invalid UTF-8, `%00`, broken escapes (`%zz`), `;`. Does the
     framework decode the path before routing or reject it before any code runs?
   - Which methods and paths are "unknown routes" (OPTIONS, TRACE, HEAD, `/error`, `/docs`) and what
     body do they get?
   - Request bodies: encodings other than UTF-8, BOM, non-standard JSON literals, lone surrogates,
     duplicate keys, nesting depth, number length.
   - Headers that are not ASCII.
5. Do not edit any file. Output the list only.

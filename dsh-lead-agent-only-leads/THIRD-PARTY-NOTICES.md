# Third-party notices

The plugins in this repository are licensed under GPL-3.0-or-later; see [LICENSE](LICENSE) for the
canonical license text that ships with every bundle. This file records the third-party material the
plugins embed and the license that applies to it.

## DeepSeek Harness — MIT

`dsh-lead-agent-only-leads/cordis.patch.yml` embeds the plan-mode system-prompt section of DeepSeek
Harness, reproduced unchanged: 11 lines, 2,361 bytes, sha256
`eab4c75ea563561b1b70dec5ec228564281b979f3b610ec0adacadb435c08951`.

Provenance: `packages/bundle/web-app/presets/standard.patch.yml:55` of the DeepSeek Harness repository
(the same text also appears at `ptc.patch.yml:55` and `cordis.patch.yml:54` of that repository).
DeepSeek Harness is licensed under the MIT License, reproduced in full below (source: the DeepSeek
Harness `LICENSE` file, sha256
`ebb4f09972aee8608be255debaf78451a68e95c290f55c240dec2ecfa16ea6be`). The MIT License applies to that
embedded text alone; it does not extend to the rest of this repository's code.

```text
MIT License

Copyright (c) 2026 DeepSeek

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## This repository

Copyright (c) 2026 Luchang Jin.

The GPL-3.0-or-later grant covers the plugins in this repository. Every bundle ships the canonical GNU
GPL v3 text as its `LICENSE` file, identical in each bundle (sha256
`8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903`). Nothing in this repository is
published to an npm registry: the bundles are installed from a local checkout, a local `npm pack`
tarball, or a Git URL.

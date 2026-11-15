"""Cached, text-only equivalent of the flag census's six grep reader scans."""
from pathlib import Path
import os
import re


ROOTS = ('src', 'scripts', 'packages', 'tests')
SUFFIXES = ('.ts', '.mts', '.js')


def reader_patterns(name: str) -> dict[str, tuple[str, tuple[str, ...]]]:
    """Keep the original patterns, including process.env's prefix bracket read.

    These are static text matches, not a TypeScript parser: comments and strings
    still count, and destructured means the historical e/ev/env0/e0/cfg aliases.
    """
    return {
        'env_getter': (rf'env\(\)\.{name}\b', ('src',)),
        'destructured': (rf'\b(e|ev|env0|e0|cfg)\.{name}\b', ('src',)),
        'env_shim': (rf'envShim\(\)\.{name}\b', ('src',)),
        'bare_word': (rf'\b{name}\b', ('src', 'scripts', 'packages')),
        'process_env': (rf'process\.env\.{name}\b|process\.env\[.{{0,4}}{name}', ('src', 'scripts')),
        'tests': (rf'\b{name}\b', ('tests',)),
    }


def is_declaration(path: str) -> bool:
    return path.endswith('src/env.ts') or path.startswith('src/env-sections/')


class ReaderIndex:
    """Read eligible files once; every query uses the same source snapshot.

    Preserve CR and NUL rather than universal-newline/binary-file filtering.
    UTF-8 surrogateescape preserves undecodable bytes as non-word characters.
    Sorted POSIX paths make Windows and Linux output independent of walk order.
    Like grep -r, do not follow symlinks encountered inside a source tree.
    """
    def __init__(self, root: str | Path = '.'):
        base = Path(root)
        self.files: list[tuple[str, str]] = []
        for tree in ROOTS:
            for directory, dirs, names in os.walk(base / tree, followlinks=False):
                dirs[:] = sorted(d for d in dirs if not (Path(directory) / d).is_symlink())
                for name in sorted(names):
                    path = Path(directory) / name
                    relative = path.relative_to(base).as_posix()
                    if not name.endswith(SUFFIXES) or path.is_symlink() or is_declaration(relative):
                        continue
                    self.files.append((relative, path.read_bytes().decode('utf-8', errors='surrogateescape')))
        self.files.sort(key=lambda entry: entry[0])

    def hits(self, pattern: str, paths: tuple[str, ...],
             candidates: list[tuple[str, str]] | None = None) -> list[str]:
        expression = re.compile(pattern)
        prefixes = tuple(path.rstrip('/\\') + '/' for path in paths)
        files = self.files if candidates is None else candidates
        return [path for path, text in files if path.startswith(prefixes) and expression.search(text)]

    def readers_of(self, name: str) -> dict[str, list[str]]:
        # Every original expression contains the literal schema key. This cheap
        # prefilter cannot discard a match (including the bracket prefix case),
        # and avoids six regex scans through thousands of unrelated files.
        candidates = [(path, text) for path, text in self.files if name in text]
        return {kind: self.hits(pattern, paths, candidates)
                for kind, (pattern, paths) in reader_patterns(name).items()}

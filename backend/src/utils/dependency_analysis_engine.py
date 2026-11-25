#!/usr/bin/env python3
"""Static dependency extraction for CodeXR directory analyses.

Tree-sitter is used as the structured parser availability layer. Language
adapters deliberately keep lexical fallbacks so every metric language reports
capabilities and warnings instead of failing silently when a grammar cannot be
loaded on a particular platform.
"""

import hashlib
import json
import os
import re
from collections import defaultdict
from pathlib import Path
from typing import Dict, Iterable, Iterator, List, Optional, Set, Tuple

from directory_scan_utils import is_analyzable_file_path, scan_directory_files_for_analysis
from metric_language_contract import get_metric_language, get_metric_language_names

RELATIONS = ("import", "include", "require", "inheritance", "implementation", "call", "contains")
CACHE_VERSION = 3

CAPABILITIES = {
    language: {
        relation: (
            "exact" if relation in {"import", "include", "require", "contains"}
            else "best-effort"
        )
        for relation in RELATIONS
    }
    for language in get_metric_language_names()
}

IMPORT_PATTERNS = [
    ("include", re.compile(r'(?m)^\s*#\s*include\s*[<"]([^>"]+)[>"]')),
    ("import", re.compile(r'(?m)^\s*(?:from\s+([\w.]+)\s+import|import\s+([\w.]+))')),
    ("import", re.compile(r'(?m)^\s*import\s+(?:[\w.*{},\s]+\s+from\s+)?[\'"]([^\'"]+)[\'"]')),
    ("require", re.compile(r'(?m)\brequire\s*\(?\s*[\'"]([^\'"]+)[\'"]')),
    ("import", re.compile(r'(?m)^\s*(?:use|using)\s+([A-Za-z_][\w.:/]*)')),
    ("import", re.compile(r'(?m)^\s*import\s+([A-Za-z_][\w.:/]*)')),
    ("import", re.compile(r'(?m)^\s*import\s+from\s+([A-Za-z_][\w.:/]*)')),
    ("import", re.compile(r'(?m)^\s*with\s+([A-Za-z_][\w.]*)')),
    ("import", re.compile(r'(?m)^\s*-include(?:_lib)?\s*\(\s*"([^"]+)"\s*\)')),
    ("import", re.compile(r'(?m)^\s*uses\s+([A-Za-z_][\w.]*)')),
    ("import", re.compile(r'(?m)^\s*friend\s+module\s+([A-Za-z_][\w.]*)')),
    ("import", re.compile(r'@import\s*\(\s*"([^"]+)"\s*\)')),
]

INHERITANCE_PATTERNS = [
    ("inheritance", re.compile(
        r'\b(?:class|interface|struct)[ \t]+\w+[^{:\n]*(?:extends[ \t]+|:[ \t]*)([A-Za-z_][\w.:<>]*)'
    )),
    ("implementation", re.compile(r'\b(?:implements|with)\s+([A-Za-z_][\w.:<>]*)')),
    ("inheritance", re.compile(r'(?m)^\s*extends\s+[\'"]?([^\'"\s]+)')),
]

CALL_PATTERN = re.compile(r'\b([A-Za-z_][\w.]*)\s*\(')
CALL_KEYWORDS = {
    "if", "for", "while", "switch", "catch", "return", "sizeof", "typeof",
    "function", "func", "def", "class", "new", "print", "echo", "match",
}

SYMBOL_TYPE_MAP = {
    "interface": "interface", "trait": "trait", "struct": "struct",
    "record": "record", "enum": "enum",
}


def _portable_relative(root: str, file_path: str) -> str:
    return os.path.relpath(file_path, root).replace("\\", "/")


def _node_id(kind: str, value: str) -> str:
    digest = hashlib.sha256(f"{kind}\0{value}".encode("utf-8")).hexdigest()[:16]
    return f"{kind}:{digest}"


def _read_text(file_path: str) -> Tuple[str, Optional[str]]:
    try:
        return Path(file_path).read_text(encoding="utf-8"), None
    except UnicodeDecodeError:
        try:
            return Path(file_path).read_text(encoding="utf-8", errors="replace"), "invalid UTF-8 replaced"
        except OSError as error:
            return "", str(error)
    except OSError as error:
        return "", str(error)


def _extract_structured_targets(language: str, text: str) -> Tuple[bool, List[Tuple[str, str, str]]]:
    aliases = {
        "C++": "cpp", "C#": "csharp", "Objective-C": "objc",
        "JavaScript": "javascript", "TypeScript": "typescript",
        "TTCN-3": "ttcn", "GDScript": "gdscript",
    }
    grammar = aliases.get(language, language.lower().replace("-", "").replace(" ", "_"))
    try:
        from tree_sitter_language_pack import ProcessConfig, process
        result = process(
            text,
            ProcessConfig(
                language=grammar,
                structure=False,
                imports=True,
                exports=False,
                comments=False,
                docstrings=False,
                symbols=False,
                diagnostics=False,
            ),
        )
        structured: List[Tuple[str, str, str]] = []
        for import_info in result.imports or []:
            source = str(getattr(import_info, "source", "") or "")
            structured.extend(
                target
                for target in _extract_targets(source)
                if target[0] in {"import", "include", "require"}
            )
        return True, structured
    except Exception:
        return False, []


def _iter_raw_targets(text: str) -> Iterator[Tuple[str, str, str, int]]:
    """Yield (kind, value, confidence, match offset) in source-pattern order."""
    for kind, pattern in IMPORT_PATTERNS + INHERITANCE_PATTERNS:
        for match in pattern.finditer(text):
            value = next((group for group in match.groups() if group), "")
            for part in re.split(r"\s*,\s*", value):
                normalized = part.strip().strip("\"'").split("<", 1)[0]
                if normalized:
                    confidence = "exact" if kind in {"import", "include", "require"} else "probable"
                    yield kind, normalized, confidence, match.start()
    for match in CALL_PATTERN.finditer(text):
        value = match.group(1)
        leaf = value.rsplit(".", 1)[-1]
        if leaf.lower() not in CALL_KEYWORDS:
            yield "call", value, "ambiguous", match.start()


def _extract_targets(text: str) -> List[Tuple[str, str, str]]:
    return [(kind, value, confidence) for kind, value, confidence, _offset in _iter_raw_targets(text)]


def _extract_targets_with_lines(text: str) -> List[Tuple[str, str, str, int]]:
    return [
        (kind, value, confidence, text.count("\n", 0, offset) + 1)
        for kind, value, confidence, offset in _iter_raw_targets(text)
    ]


def _empty_metrics(**values: object) -> Dict[str, object]:
    metrics: Dict[str, object] = {
        "totalLines": 0, "fanIn": 0, "fanOut": 0, "degree": 0,
        "dependentCount": 0, "cycleSize": 0, "relationCount": 0,
    }
    metrics.update(values)
    return metrics


def _symbol_type(raw_type: str) -> str:
    lowered = str(raw_type or "").lower()
    for token, normalized in SYMBOL_TYPE_MAP.items():
        if token in lowered:
            return normalized
    return "class"


def _infer_class_owner(
    classes: List[Dict[str, object]],
    class_ids: Dict[str, str],
    source_lines: List[str],
    line_start: int,
    qualified_name: str,
    language: str,
) -> Optional[str]:
    qualified_lower = qualified_name.lower()
    for class_name, class_id in class_ids.items():
        if class_name in qualified_lower:
            return class_id
    candidates = [
        item for item in classes
        if int(item.get("line", 0) or 0) < line_start
    ]
    for class_info in reversed(candidates):
        class_line = int(class_info.get("line", 0) or 0)
        if class_line <= 0 or class_line > len(source_lines):
            continue
        class_name = str(class_info.get("name") or "").lower()
        if language in {"Python", "GDScript"}:
            declaration = source_lines[class_line - 1]
            class_indent = len(declaration) - len(declaration.lstrip())
            function_line = source_lines[line_start - 1] if line_start <= len(source_lines) else ""
            function_indent = len(function_line) - len(function_line.lstrip())
            if function_indent <= class_indent:
                continue
            scope_open = True
            for line in source_lines[class_line:line_start - 1]:
                stripped = line.strip()
                if not stripped or stripped.startswith(("#", "@")):
                    continue
                indent = len(line) - len(line.lstrip())
                if indent <= class_indent:
                    scope_open = False
                    break
            if scope_open:
                return class_ids.get(class_name)
        else:
            body = "\n".join(source_lines[class_line - 1:line_start])
            if body.count("{") > body.count("}"):
                return class_ids.get(class_name)
    return None


def _resolve_project_root(file_path: str, project_root: Optional[str]) -> str:
    target = os.path.realpath(file_path)
    if project_root:
        candidate = os.path.realpath(project_root)
        try:
            if os.path.commonpath([candidate, target]) == candidate:
                return candidate
        except ValueError:
            pass
    current = os.path.dirname(target)
    while True:
        if os.path.isdir(os.path.join(current, ".git")):
            return current
        parent = os.path.dirname(current)
        if parent == current:
            return os.path.dirname(target)
        current = parent


def _find_block_end(source_lines: List[str], line_number: int, line: str, language: str) -> int:
    """Last line of an indentation-delimited body (Python, GDScript); else the start line."""
    line_end = line_number
    if language in {"Python", "GDScript"}:
        function_indent = len(line) - len(line.lstrip())
        for candidate_number, candidate in enumerate(
            source_lines[line_number:], start=line_number + 1
        ):
            stripped = candidate.strip()
            if stripped and not stripped.startswith(("#", "@")):
                indent = len(candidate) - len(candidate.lstrip())
                if indent <= function_indent:
                    break
            line_end = candidate_number
    return line_end


def _lexical_function_entry(name: str, line_start: int, line_end: int) -> Dict[str, object]:
    return {
        "functionName": name,
        "qualifiedName": name,
        "lineStart": line_start,
        "lineEnd": line_end,
        "lineCount": max(1, line_end - line_start + 1),
        "complexity": 0,
        "parameters": 0,
        "maxNestingDepth": 0,
    }


def _build_file_dependency_snapshot(file_path: str, text: str) -> Tuple[Dict[str, object], Optional[str]]:
    try:
        from file_analysis_engine import build_file_snapshot
        snapshot = build_file_snapshot(file_path)
        language = str(snapshot.get("language") or get_metric_language(file_path))
        source_lines = text.splitlines()
        existing = {
            (str(item.get("functionName") or ""), int(item.get("lineStart", 0) or 0))
            for item in snapshot.get("functions", [])
        }
        for line_number, line in enumerate(source_lines, start=1):
            function_match = re.search(
                r'\b(?:def|function|func|fn|sub)[ \t]+([A-Za-z_]\w*)',
                line,
            )
            if not function_match or (function_match.group(1), line_number) in existing:
                continue
            line_end = _find_block_end(source_lines, line_number, line, language)
            snapshot.setdefault("functions", []).append(
                _lexical_function_entry(function_match.group(1), line_number, line_end)
            )
        snapshot["functions"] = sorted(
            snapshot.get("functions", []),
            key=lambda item: (int(item.get("lineStart", 0) or 0), str(item.get("functionName") or "")),
        )
        return snapshot, None
    except ModuleNotFoundError as error:
        language = get_metric_language(file_path)
        functions = []
        classes = []
        source_lines = text.splitlines()
        for line_number, line in enumerate(source_lines, start=1):
            class_match = re.search(
                r'\b(?:class|interface|trait|struct|record|enum)[ \t]+([A-Za-z_]\w*)',
                line,
            )
            if class_match:
                token = line[:class_match.start()].strip().split()
                raw_type = token[-1] if token else line[class_match.start():].split()[0]
                classes.append({
                    "name": class_match.group(1),
                    "type": raw_type,
                    "line": line_number,
                })
            function_match = re.search(
                r'\b(?:def|function|func|fn|sub)[ \t]+([A-Za-z_]\w*)',
                line,
            )
            if function_match:
                line_end = _find_block_end(source_lines, line_number, line, language)
                functions.append(_lexical_function_entry(function_match.group(1), line_number, line_end))
        return {
            "language": language,
            "classes": classes,
            "functions": functions,
        }, f"Lizard unavailable ({error}); lexical symbol fallback used"


def _add_graph_metrics(nodes: List[Dict[str, object]], edges: List[Dict[str, object]]) -> None:
    node_by_id = {str(node["id"]): node for node in nodes}
    adjacency: Dict[str, Set[str]] = defaultdict(set)
    reverse: Dict[str, Set[str]] = defaultdict(set)
    relation_counts: Dict[object, int] = defaultdict(int)
    for edge in edges:
        source = str(edge["source"])
        target = str(edge["target"])
        adjacency[source].add(target)
        reverse[target].add(source)
        # An edge touches its source and its target; a self-edge counts once,
        # exactly like the per-node `source == id or target == id` test it replaces.
        relation_counts[edge["source"]] += 1
        if edge["target"] != edge["source"]:
            relation_counts[edge["target"]] += 1
    internal_ids = [str(node["id"]) for node in nodes if not node.get("external")]
    components = _tarjan(internal_ids, adjacency)
    cycle_sizes = {
        node_id: len(component)
        for component in components if len(component) > 1
        for node_id in component
    }
    for node_id, node in node_by_id.items():
        outgoing = adjacency.get(node_id, set())
        incoming = reverse.get(node_id, set())
        node["metrics"].update({
            "fanIn": len(incoming),
            "fanOut": len(outgoing),
            "degree": len(incoming | outgoing),
            "dependentCount": len(incoming),
            "cycleSize": cycle_sizes.get(node_id, 0),
            "relationCount": relation_counts.get(node_id, 0),
        })


def _first_match(reference: str, lookup: Dict[str, str]) -> Optional[str]:
    """Node id of the first candidate key of ``reference`` found in ``lookup``."""
    return next((lookup[key] for key in _normalize_reference(reference) if key in lookup), None)


def _ensure_external_node(
    reference: str,
    external_nodes: Dict[str, str],
    nodes: List[Dict[str, object]],
) -> str:
    """Id of the external node named by ``reference``'s first segment.

    The node is appended to ``nodes`` the first time its (case-folded) name is seen.
    """
    external_key = re.split(r"[/.:]", reference.strip())[0] or reference.strip()
    target_id = external_nodes.get(external_key.lower())
    if not target_id:
        target_id = _node_id("external", external_key.lower())
        external_nodes[external_key.lower()] = target_id
        nodes.append({
            "id": target_id, "kind": "external", "label": external_key,
            "external": True, "metrics": _empty_metrics(),
        })
    return target_id


def _contains_edge(owner_id: str, symbol_id: str) -> Dict[str, object]:
    return {
        "id": _node_id("edge", f"{owner_id}\0{symbol_id}\0contains"),
        "source": owner_id, "target": symbol_id, "kind": "contains",
        "confidence": "exact", "occurrences": 1,
    }


def _add_class_symbols(
    classes: List[Dict[str, object]],
    relative: str,
    language: str,
    module_id: str,
    nodes: List[Dict[str, object]],
    edges: List[Dict[str, object]],
    symbol_lookup: Dict[str, str],
) -> Dict[str, str]:
    """One symbol node and one module->class contains edge per class; returns name -> id."""
    class_ids: Dict[str, str] = {}
    for class_info in classes:
        name = str(class_info.get("name") or "anonymous")
        line = int(class_info.get("line", 0) or 0)
        symbol_kind = _symbol_type(str(class_info.get("type") or "class"))
        symbol_id = _node_id("symbol", f"{relative.lower()}\0{symbol_kind}\0{name}\0{line}")
        class_ids[name.lower()] = symbol_id
        nodes.append({
            "id": symbol_id, "kind": "symbol", "symbolKind": symbol_kind,
            "label": name, "relativePath": relative, "language": language,
            "external": False, "ownerId": module_id, "lineStart": line,
            "metrics": _empty_metrics(),
        })
        edges.append(_contains_edge(module_id, symbol_id))
        symbol_lookup[name.lower()] = symbol_id
    return class_ids


def _add_function_symbols(
    functions: List[Dict[str, object]],
    classes: List[Dict[str, object]],
    class_ids: Dict[str, str],
    source_lines: List[str],
    relative: str,
    language: str,
    module_id: str,
    nodes: List[Dict[str, object]],
    edges: List[Dict[str, object]],
    symbol_lookup: Dict[str, str],
) -> List[Tuple[int, int, str]]:
    """One function/method node and its contains edge per function; returns the line ranges."""
    function_ranges: List[Tuple[int, int, str]] = []
    for ordinal, function in enumerate(functions):
        name = str(function.get("functionName") or "unknown")
        qualified = str(function.get("qualifiedName") or name)
        line_start = int(function.get("lineStart", 0) or 0)
        line_end = int(function.get("lineEnd", line_start) or line_start)
        owner_id = _infer_class_owner(
            classes, class_ids, source_lines, line_start, qualified, language
        ) or module_id
        symbol_kind = "method" if owner_id != module_id else "function"
        symbol_id = _node_id(
            "symbol",
            f"{relative.lower()}\0{symbol_kind}\0{qualified}\0{line_start}\0{ordinal}",
        )
        nodes.append({
            "id": symbol_id, "kind": "symbol", "symbolKind": symbol_kind,
            "label": name, "relativePath": relative, "language": language,
            "external": False, "ownerId": owner_id,
            "lineStart": line_start, "lineEnd": line_end,
            "metrics": _empty_metrics(
                totalLines=int(function.get("lineCount", 0) or 0),
                complexity=float(function.get("complexity", 0) or 0),
                parameters=int(function.get("parameters", 0) or 0),
                nestingDepth=int(function.get("maxNestingDepth", 0) or 0),
            ),
        })
        edges.append(_contains_edge(owner_id, symbol_id))
        symbol_lookup.setdefault(name.lower(), symbol_id)
        symbol_lookup.setdefault(qualified.lower(), symbol_id)
        function_ranges.append((line_start, line_end, symbol_id))
    return function_ranges


def _project_file_lookup(root: str, target: str) -> Tuple[Dict[str, str], Dict[str, str]]:
    """(candidate key -> file node id, file node id -> relative path) for the project's other files."""
    local_lookup: Dict[str, str] = {}
    local_paths: Dict[str, str] = {}
    try:
        project_files = scan_directory_files_for_analysis(
            root, recursive=True, max_entries_per_directory=1000, max_total_files=5000,
        )
    except Exception:
        project_files = []
    for candidate in project_files:
        candidate_relative = _portable_relative(root, candidate)
        if os.path.realpath(candidate) == target:
            continue
        candidate_id = _node_id("file", candidate_relative.lower())
        local_paths[candidate_id] = candidate_relative
        for key in _candidate_keys(candidate_relative):
            local_lookup.setdefault(key, candidate_id)
    return local_lookup, local_paths


def _resolve_file_edge_counts(
    text: str,
    module_id: str,
    function_ranges: List[Tuple[int, int, str]],
    symbol_lookup: Dict[str, str],
    local_lookup: Dict[str, str],
    local_paths: Dict[str, str],
    nodes: List[Dict[str, object]],
) -> Tuple[Dict[Tuple[str, str, str, str], int], Dict[str, Dict[str, object]]]:
    """Edge counts for one file, plus the project files it reaches.

    A call goes from its enclosing function (else the module) to a known symbol and is
    dropped when none matches. Any other relation goes from the module to a project file
    or, failing that, to an external node (appended to ``nodes``). Self-references are dropped.
    """
    external_nodes: Dict[str, str] = {}
    local_nodes: Dict[str, Dict[str, object]] = {}
    edge_counts: Dict[Tuple[str, str, str, str], int] = defaultdict(int)
    for relation, reference, confidence, line in _extract_targets_with_lines(text):
        if relation == "call":
            source_id = next((
                symbol_id for start, end, symbol_id in function_ranges
                if start <= line <= end
            ), module_id)
            target_id = _first_match(reference, symbol_lookup)
            if not target_id:
                continue
        else:
            source_id = module_id
            target_id = _first_match(reference, local_lookup)
            if not target_id:
                target_id = _ensure_external_node(reference, external_nodes, nodes)
            elif target_id not in local_nodes:
                local_relative = local_paths.get(target_id, reference)
                local_nodes[target_id] = {
                    "id": target_id, "kind": "file",
                    "label": Path(local_relative).name,
                    "relativePath": local_relative,
                    "external": False, "metrics": _empty_metrics(),
                }
        if source_id != target_id:
            edge_counts[(source_id, target_id, relation, confidence)] += 1
    return edge_counts, local_nodes


def analyze_file_dependencies(
    file_path: str,
    project_root: Optional[str] = None,
    cache_path: Optional[str] = None,
) -> Dict[str, object]:
    target = os.path.realpath(file_path)
    if not os.path.isfile(target) or not is_analyzable_file_path(target):
        raise ValueError(f"Dependency target is not an analyzable file: {file_path}")
    root = _resolve_project_root(target, project_root)
    try:
        relative = _portable_relative(root, target)
    except ValueError:
        root = os.path.dirname(target)
        relative = Path(target).name

    text, warning = _read_text(target)
    snapshot, snapshot_warning = _build_file_dependency_snapshot(target, text)
    language = str(snapshot.get("language") or get_metric_language(target))
    source_lines = text.splitlines()
    module_id = _node_id("symbol", f"{relative.lower()}\0module")
    nodes: List[Dict[str, object]] = [{
        "id": module_id,
        "kind": "symbol",
        "symbolKind": "module",
        "label": Path(relative).name,
        "relativePath": relative,
        "language": language,
        "external": False,
        "lineStart": 1,
        "lineEnd": max(1, len(source_lines)),
        "metrics": _empty_metrics(totalLines=max(1, len(source_lines))),
    }]
    edges: List[Dict[str, object]] = []
    symbol_lookup: Dict[str, str] = {}

    classes = sorted(snapshot.get("classes", []), key=lambda item: int(item.get("line", 0) or 0))
    class_ids = _add_class_symbols(classes, relative, language, module_id, nodes, edges, symbol_lookup)
    function_ranges = _add_function_symbols(
        snapshot.get("functions", []), classes, class_ids, source_lines,
        relative, language, module_id, nodes, edges, symbol_lookup,
    )
    local_lookup, local_paths = _project_file_lookup(root, target)
    edge_counts, local_nodes = _resolve_file_edge_counts(
        text, module_id, function_ranges, symbol_lookup, local_lookup, local_paths, nodes,
    )
    nodes.extend(local_nodes.values())
    edges.extend(_build_edges(edge_counts))
    _add_graph_metrics(nodes, edges)

    warnings = []
    if warning:
        warnings.append(f"{relative}: {warning}")
    if snapshot_warning:
        warnings.append(f"{relative}: {snapshot_warning}")
    return {
        "schemaVersion": 2, "revision": 0, "targetType": "file",
        "targetRelativePath": relative, "nodes": nodes, "edges": edges,
        "warnings": warnings, "capabilities": CAPABILITIES, "generatedAt": "",
    }


def _candidate_keys(relative_path: str) -> Set[str]:
    portable = relative_path.replace("\\", "/")
    without_suffix = portable.rsplit(".", 1)[0]
    name = Path(portable).stem
    return {
        portable.lower(),
        without_suffix.lower(),
        without_suffix.replace("/", ".").lower(),
        name.lower(),
    }


def _normalize_reference(reference: str) -> List[str]:
    value = reference.strip().replace("\\", "/")
    value = re.sub(r"^(?:crate|self|super|root)::", "", value)
    value = value.replace("::", "/")
    value = re.sub(r"^\./", "", value)
    without_suffix = value.rsplit(".", 1)[0] if "/" in value and "." in Path(value).name else value
    return list({
        value.lower(),
        without_suffix.lower(),
        value.replace(".", "/").lower(),
        Path(value).stem.lower(),
    })


def _tarjan(nodes: Iterable[str], adjacency: Dict[str, Set[str]]) -> List[List[str]]:
    index = 0
    stack: List[str] = []
    indices: Dict[str, int] = {}
    lowlink: Dict[str, int] = {}
    on_stack: Set[str] = set()
    components: List[List[str]] = []

    def visit(node: str) -> None:
        nonlocal index
        indices[node] = index
        lowlink[node] = index
        index += 1
        stack.append(node)
        on_stack.add(node)
        for target in adjacency.get(node, set()):
            if target not in indices:
                visit(target)
                lowlink[node] = min(lowlink[node], lowlink[target])
            elif target in on_stack:
                lowlink[node] = min(lowlink[node], indices[target])
        if lowlink[node] == indices[node]:
            component = []
            while stack:
                current = stack.pop()
                on_stack.remove(current)
                component.append(current)
                if current == node:
                    break
            components.append(component)

    for node in nodes:
        if node not in indices:
            visit(node)
    return components


def _load_cache(cache_path: Optional[str]) -> Dict[str, object]:
    if not cache_path:
        return {"version": CACHE_VERSION, "files": {}}
    try:
        payload = json.loads(Path(cache_path).read_text(encoding="utf-8"))
        if payload.get("version") == CACHE_VERSION and isinstance(payload.get("files"), dict):
            return payload
    except (OSError, ValueError, TypeError):
        pass
    return {"version": CACHE_VERSION, "files": {}}


def _write_cache(cache_path: Optional[str], cache: Dict[str, object]) -> None:
    if not cache_path:
        return
    target = Path(cache_path)
    target.parent.mkdir(parents=True, exist_ok=True)
    temporary = target.with_suffix(target.suffix + ".tmp")
    temporary.write_text(json.dumps(cache, separators=(",", ":")), encoding="utf-8")
    temporary.replace(target)


def _load_refresh_request(root: str, request_path: Optional[str]) -> Optional[Dict[str, object]]:
    if not request_path:
        return None
    try:
        payload = json.loads(Path(request_path).read_text(encoding="utf-8"))
    except (OSError, ValueError, TypeError) as error:
        raise ValueError(f"Invalid dependency refresh request: {error}") from error

    normalized: Dict[str, object] = {
        "sourceRevision": int(payload.get("sourceRevision", 0)),
        "forceFullScan": bool(payload.get("forceFullScan", False)),
    }
    for key in ("changedFiles", "addedFiles", "removedFiles"):
        paths: List[str] = []
        for candidate in payload.get(key, []):
            resolved = os.path.realpath(str(candidate))
            if os.path.commonpath([root, resolved]) != root:
                raise ValueError(f"Dependency refresh path escapes analysis root: {candidate}")
            paths.append(resolved)
        normalized[key] = paths
    return normalized


TargetTuple = Tuple[str, str, str]


def _resolve_scan_set(
    root: str,
    recursive: bool,
    refresh: Optional[Dict[str, object]],
    cached_files: Dict[str, object],
) -> Tuple[Dict[str, str], Set[str]]:
    """Files to put in the graph (relative -> absolute) and the ones that must be re-read.

    A full scan re-reads everything; an incremental refresh starts from the cached
    files still on disk, drops the removed ones and re-reads the changed and added ones.
    """
    files_by_relative: Dict[str, str] = {}
    refresh_relative: Set[str] = set()
    full_scan = refresh is None or bool(refresh.get("forceFullScan")) or not cached_files

    if full_scan:
        files = scan_directory_files_for_analysis(
            root,
            recursive=recursive,
            max_entries_per_directory=1000,
            max_total_files=5000,
        )
        files_by_relative = {_portable_relative(root, file_path): file_path for file_path in files}
        refresh_relative = set(files_by_relative)
    else:
        for relative in cached_files:
            file_path = os.path.realpath(os.path.join(root, relative))
            if os.path.isfile(file_path):
                files_by_relative[relative] = file_path
        for removed_path in refresh.get("removedFiles", []):
            files_by_relative.pop(_portable_relative(root, str(removed_path)), None)
        for key in ("changedFiles", "addedFiles"):
            for file_path in refresh.get(key, []):
                file_path = str(file_path)
                if not is_analyzable_file_path(file_path):
                    continue
                relative = _portable_relative(root, file_path)
                files_by_relative[relative] = file_path
                refresh_relative.add(relative)

    return files_by_relative, refresh_relative


def _cached_targets(cached_entry: object, language: str) -> Optional[Tuple[List[TargetTuple], bool, str, int]]:
    """(targets, parserAvailable, hash, totalLines) from a usable cache entry, else None."""
    usable = (
        isinstance(cached_entry, dict)
        and cached_entry.get("language") == language
        and isinstance(cached_entry.get("targets"), list)
        and isinstance(cached_entry.get("totalLines"), int)
    )
    if not usable:
        return None
    targets = [tuple(item) for item in cached_entry["targets"] if isinstance(item, list) and len(item) == 3]
    parser_available = bool(cached_entry.get("parserAvailable"))
    content_hash = str(cached_entry.get("hash", ""))
    total_lines = int(cached_entry.get("totalLines", 0))
    return targets, parser_available, content_hash, total_lines


def _extract_file_targets(
    relative: str,
    file_path: str,
    language: str,
    warnings: List[str],
) -> Tuple[List[TargetTuple], bool, str, int]:
    """Read one file and extract its (sorted, de-duplicated) dependency targets."""
    text, warning = _read_text(file_path)
    if warning:
        warnings.append(f"{relative}: {warning}")
    content_hash = hashlib.sha256(text.encode("utf-8")).hexdigest()
    parser_available, structured_targets = _extract_structured_targets(language, text)
    targets = sorted({
        target
        for target in [*structured_targets, *_extract_targets(text)]
    })
    total_lines = len(text.splitlines())
    return targets, parser_available, content_hash, total_lines


def _file_node(node_id: str, relative: str, language: str, total_lines: int) -> Dict[str, object]:
    return {
        "id": node_id,
        "kind": "file",
        "label": Path(relative).name,
        "relativePath": relative,
        "language": language,
        "external": False,
        "metrics": _empty_metrics(totalLines=total_lines),
    }


def _resolve_edge_counts(
    parsed: List[str],
    extracted_by_node: Dict[str, List[TargetTuple]],
    lookup: Dict[str, str],
    nodes: List[Dict[str, object]],
) -> Dict[Tuple[str, str, str, str], int]:
    """Resolve every target to a file node or an external node (appended to ``nodes``).

    Self-references are dropped; the first candidate key that resolves wins.
    """
    edge_counts: Dict[Tuple[str, str, str, str], int] = defaultdict(int)
    external_nodes: Dict[str, str] = {}
    for source_id in parsed:
        for relation, reference, confidence in extracted_by_node[source_id]:
            target_id = _first_match(reference, lookup)
            if target_id == source_id:
                continue
            if not target_id:
                target_id = _ensure_external_node(reference, external_nodes, nodes)
            edge_counts[(source_id, target_id, relation, confidence)] += 1
    return edge_counts


def _build_edges(edge_counts: Dict[Tuple[str, str, str, str], int]) -> List[Dict[str, object]]:
    edges = []
    for (source, target, kind, confidence), occurrences in edge_counts.items():
        edge_id = _node_id("edge", f"{source}\0{target}\0{kind}")
        edges.append({
            "id": edge_id,
            "source": source,
            "target": target,
            "kind": kind,
            "confidence": confidence,
            "occurrences": occurrences,
        })
    return edges


def analyze_dependencies(
    directory_path: str,
    recursive: bool = False,
    cache_path: Optional[str] = None,
    refresh_request_path: Optional[str] = None,
) -> Dict[str, object]:
    root = os.path.realpath(directory_path)
    refresh = _load_refresh_request(root, refresh_request_path)
    nodes: List[Dict[str, object]] = []
    warnings: List[str] = []
    lookup: Dict[str, str] = {}
    parsed: List[str] = []
    parser_availability: Dict[str, bool] = {}
    cache = _load_cache(cache_path)
    cached_files = cache["files"] if cache.get("root") == root else {}
    next_cached_files: Dict[str, object] = {}
    extracted_by_node: Dict[str, List[TargetTuple]] = {}
    files_by_relative, refresh_relative = _resolve_scan_set(root, recursive, refresh, cached_files)

    for relative, file_path in sorted(files_by_relative.items()):
        language = get_metric_language(file_path)
        node_id = _node_id("file", relative.lower())
        cached = None if relative in refresh_relative else _cached_targets(cached_files.get(relative), language)
        if cached is None:
            cached = _extract_file_targets(relative, file_path, language, warnings)
        targets, parser_available, content_hash, total_lines = cached
        parser_availability.setdefault(language, parser_available)
        extracted_by_node[node_id] = targets
        next_cached_files[relative] = {
            "hash": content_hash,
            "language": language,
            "parserAvailable": parser_available,
            "targets": [list(item) for item in targets],
            "totalLines": total_lines,
        }
        nodes.append(_file_node(node_id, relative, language, total_lines))
        for key in _candidate_keys(relative):
            lookup.setdefault(key, node_id)
        parsed.append(node_id)

    edges = _build_edges(_resolve_edge_counts(parsed, extracted_by_node, lookup, nodes))
    _add_graph_metrics(nodes, edges)

    for language, available in parser_availability.items():
        if not available:
            warnings.append(f"{language}: structured parser unavailable; lexical adapter used")

    _write_cache(cache_path, {
        "version": CACHE_VERSION,
        "root": root,
        "files": next_cached_files,
    })

    return {
        "schemaVersion": 2,
        "revision": 0,
        "targetType": "directory",
        "targetRelativePath": "",
        "nodes": nodes,
        "edges": edges,
        "warnings": sorted(set(warnings)),
        "capabilities": CAPABILITIES,
        "generatedAt": "",
    }

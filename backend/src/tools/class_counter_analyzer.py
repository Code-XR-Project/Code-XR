#!/usr/bin/env python3
"""
Class Counter Analyzer

This script analyzes a file and counts the number of class declarations.
It supports multiple programming languages with comprehensive pattern matching.
Imported by utils/file_analysis_engine.py; it has no command line of its own.
"""

import os
import re
from typing import Any, Dict, List, Tuple


# Python: dataclasses first (they would otherwise also match the plain class pattern)
_PYTHON_DATACLASS_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*@dataclass\s*\n\s*class\s+(\w+)', 'dataclass'),
    (r'^\s*@dataclasses\.dataclass\s*\n\s*class\s+(\w+)', 'dataclass'),
]

# JavaScript/TypeScript classes, interfaces, types
_JS_TS_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*export\s+class\s+(\w+)', 'exported_class'),
    (r'^\s*export\s+default\s+class\s+(\w+)', 'default_class'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*export\s+interface\s+(\w+)', 'exported_interface'),
    (r'^\s*type\s+(\w+)\s*=', 'type_alias'),
    (r'^\s*export\s+type\s+(\w+)\s*=', 'exported_type'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*export\s+enum\s+(\w+)', 'exported_enum'),
    (r'^\s*const\s+enum\s+(\w+)', 'const_enum'),
    (r'^\s*declare\s+class\s+(\w+)', 'declare_class'),
    (r'^\s*declare\s+interface\s+(\w+)', 'declare_interface'),
]

# Java classes, interfaces, enums, annotations, records
_JAVA_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*public\s+class\s+(\w+)', 'public_class'),
    (r'^\s*private\s+class\s+(\w+)', 'private_class'),
    (r'^\s*protected\s+class\s+(\w+)', 'protected_class'),
    (r'^\s*package\s+class\s+(\w+)', 'package_class'),
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*public\s+interface\s+(\w+)', 'public_interface'),
    (r'^\s*private\s+interface\s+(\w+)', 'private_interface'),
    (r'^\s*protected\s+interface\s+(\w+)', 'protected_interface'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*public\s+enum\s+(\w+)', 'public_enum'),
    (r'^\s*private\s+enum\s+(\w+)', 'private_enum'),
    (r'^\s*protected\s+enum\s+(\w+)', 'protected_enum'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*@interface\s+(\w+)', 'annotation'),
    (r'^\s*public\s+@interface\s+(\w+)', 'public_annotation'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*public\s+abstract\s+class\s+(\w+)', 'public_abstract_class'),
    (r'^\s*final\s+class\s+(\w+)', 'final_class'),
    (r'^\s*public\s+final\s+class\s+(\w+)', 'public_final_class'),
    (r'^\s*public\s+record\s+(\w+)', 'public_record'),
    (r'^\s*record\s+(\w+)', 'record'),
]

# Scala classes, objects, traits, case classes
_SCALA_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*case\s+class\s+(\w+)', 'case_class'),
    (r'^\s*sealed\s+class\s+(\w+)', 'sealed_class'),
    (r'^\s*final\s+class\s+(\w+)', 'final_class'),
    (r'^\s*object\s+(\w+)', 'object'),
    (r'^\s*case\s+object\s+(\w+)', 'case_object'),
    (r'^\s*trait\s+(\w+)', 'trait'),
    (r'^\s*sealed\s+trait\s+(\w+)', 'sealed_trait'),
    (r'^\s*type\s+(\w+)\s*=', 'type_alias'),
    (r'^\s*implicit\s+class\s+(\w+)', 'implicit_class'),
    (r'^\s*implicit\s+object\s+(\w+)', 'implicit_object'),
]

# C++ classes, structs, unions, templates
_CPP_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*struct\s+(\w+)', 'struct'),
    (r'^\s*union\s+(\w+)', 'union'),
    (r'^\s*template\s*<.*>\s*class\s+(\w+)', 'template_class'),
    (r'^\s*template\s*<.*>\s*struct\s+(\w+)', 'template_struct'),
    (r'^\s*namespace\s+(\w+)', 'namespace'),
    (r'^\s*enum\s+class\s+(\w+)', 'enum_class'),
    (r'^\s*enum\s+struct\s+(\w+)', 'enum_struct'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*typedef\s+(?:class|struct)\s+(\w+)', 'typedef_class'),
]

# C# classes, interfaces, structs, enums, delegates, records
_CSHARP_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*public\s+class\s+(\w+)', 'public_class'),
    (r'^\s*private\s+class\s+(\w+)', 'private_class'),
    (r'^\s*protected\s+class\s+(\w+)', 'protected_class'),
    (r'^\s*internal\s+class\s+(\w+)', 'internal_class'),
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*public\s+interface\s+(\w+)', 'public_interface'),
    (r'^\s*private\s+interface\s+(\w+)', 'private_interface'),
    (r'^\s*protected\s+interface\s+(\w+)', 'protected_interface'),
    (r'^\s*internal\s+interface\s+(\w+)', 'internal_interface'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*public\s+struct\s+(\w+)', 'public_struct'),
    (r'^\s*private\s+struct\s+(\w+)', 'private_struct'),
    (r'^\s*protected\s+struct\s+(\w+)', 'protected_struct'),
    (r'^\s*internal\s+struct\s+(\w+)', 'internal_struct'),
    (r'^\s*struct\s+(\w+)', 'struct'),
    (r'^\s*public\s+enum\s+(\w+)', 'public_enum'),
    (r'^\s*private\s+enum\s+(\w+)', 'private_enum'),
    (r'^\s*protected\s+enum\s+(\w+)', 'protected_enum'),
    (r'^\s*internal\s+enum\s+(\w+)', 'internal_enum'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*public\s+delegate\s+\w+\s+(\w+)', 'public_delegate'),
    (r'^\s*delegate\s+\w+\s+(\w+)', 'delegate'),
    (r'^\s*public\s+record\s+(\w+)', 'public_record'),
    (r'^\s*record\s+(\w+)', 'record'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*sealed\s+class\s+(\w+)', 'sealed_class'),
    (r'^\s*static\s+class\s+(\w+)', 'static_class'),
]

# Ruby classes, modules
_RUBY_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*module\s+(\w+)', 'module'),
    (r'^\s*class\s+<<\s*(\w+)', 'singleton_class'),
]

# PHP classes, interfaces, traits
_PHP_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*final\s+class\s+(\w+)', 'final_class'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*trait\s+(\w+)', 'trait'),
    (r'^\s*enum\s+(\w+)', 'enum'),
]

# Swift classes, structs, protocols, enums
_SWIFT_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*struct\s+(\w+)', 'struct'),
    (r'^\s*protocol\s+(\w+)', 'protocol'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*actor\s+(\w+)', 'actor'),
    (r'^\s*extension\s+(\w+)', 'extension'),
    (r'^\s*public\s+class\s+(\w+)', 'public_class'),
    (r'^\s*private\s+class\s+(\w+)', 'private_class'),
    (r'^\s*internal\s+class\s+(\w+)', 'internal_class'),
    (r'^\s*open\s+class\s+(\w+)', 'open_class'),
    (r'^\s*final\s+class\s+(\w+)', 'final_class'),
]

# Go structs, interfaces, types
_GO_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*type\s+(\w+)\s+struct', 'struct'),
    (r'^\s*type\s+(\w+)\s+interface', 'interface'),
    (r'^\s*type\s+(\w+)\s+\w+', 'type_alias'),
]

# Rust structs, enums, traits, impl blocks
_RUST_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*struct\s+(\w+)', 'struct'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*trait\s+(\w+)', 'trait'),
    (r'^\s*impl\s+(\w+)', 'impl'),
    (r'^\s*impl\s+\w+\s+for\s+(\w+)', 'impl_for'),
    (r'^\s*type\s+(\w+)\s*=', 'type_alias'),
    (r'^\s*union\s+(\w+)', 'union'),
    (r'^\s*pub\s+struct\s+(\w+)', 'pub_struct'),
    (r'^\s*pub\s+enum\s+(\w+)', 'pub_enum'),
    (r'^\s*pub\s+trait\s+(\w+)', 'pub_trait'),
]

# Kotlin classes, interfaces, objects, data classes
_KOTLIN_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*data\s+class\s+(\w+)', 'data_class'),
    (r'^\s*sealed\s+class\s+(\w+)', 'sealed_class'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*open\s+class\s+(\w+)', 'open_class'),
    (r'^\s*final\s+class\s+(\w+)', 'final_class'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*object\s+(\w+)', 'object'),
    (r'^\s*enum\s+class\s+(\w+)', 'enum_class'),
    (r'^\s*annotation\s+class\s+(\w+)', 'annotation_class'),
    (r'^\s*inline\s+class\s+(\w+)', 'inline_class'),
    (r'^\s*value\s+class\s+(\w+)', 'value_class'),
]

# Objective-C classes, protocols, categories
_OBJC_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*@interface\s+(\w+)', 'interface'),
    (r'^\s*@implementation\s+(\w+)', 'implementation'),
    (r'^\s*@protocol\s+(\w+)', 'protocol'),
    (r'^\s*@interface\s+(\w+)\s*\((\w+)\)', 'category'),
]

# Lua "classes" (tables with metatables, modules)
_LUA_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*local\s+(\w+)\s*=\s*\{\}', 'table_class'),
    (r'^\s*(\w+)\s*=\s*\{\}', 'global_table'),
    (r'^\s*function\s+(\w+):new', 'class_constructor'),
    (r'^\s*local\s+(\w+)\s*=\s*class\(', 'class_declaration'),
]

# Erlang modules, records
_ERLANG_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*-module\s*\(\s*(\w+)', 'module'),
    (r'^\s*-record\s*\(\s*(\w+)', 'record'),
    (r'^\s*-behaviour\s*\(\s*(\w+)', 'behaviour'),
    (r'^\s*-behavior\s*\(\s*(\w+)', 'behavior'),
]

# Perl packages, modules
_PERL_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*package\s+(\w+(?:::\w+)*)', 'package'),
    (r'^\s*use\s+Moose;.*?package\s+(\w+)', 'moose_class'),
    (r'^\s*use\s+Mouse;.*?package\s+(\w+)', 'mouse_class'),
]

# C files - detect structs and typedefs as "classes"
_C_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*typedef\s+struct\s+(\w+)', 'typedef_struct'),
    (r'^\s*struct\s+(\w+)\s*{', 'struct'),
    (r'^\s*typedef\s+enum\s+(\w+)', 'typedef_enum'),
    (r'^\s*enum\s+(\w+)\s*{', 'enum'),
    (r'^\s*typedef\s+union\s+(\w+)', 'typedef_union'),
    (r'^\s*union\s+(\w+)\s*{', 'union'),
    (r'^\s*typedef\s+.*\s+(\w+);', 'typedef'),
]

# Solidity contracts (equivalent to classes)
_SOLIDITY_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*contract\s+(\w+)', 'contract'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*library\s+(\w+)', 'library'),
    (r'^\s*abstract\s+contract\s+(\w+)', 'abstract_contract'),
]

# Fortran types (equivalent to classes/structs)
_FORTRAN_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*type\s*::\s*(\w+)', 'type'),
    (r'^\s*type\s+(\w+)', 'type'),
    (r'^\s*module\s+(\w+)', 'module'),
    (r'^\s*interface\s+(\w+)', 'interface'),
]

# GDScript classes and class_name declarations
_GDSCRIPT_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*class_name\s+(\w+)', 'class_name'),
    (r'^\s*extends\s+(\w+)', 'extends'),
    (r'^\s*enum\s+(\w+)', 'enum'),
]

# Vue.js files - extract classes from <script> blocks
_VUE_PATTERNS: List[Tuple[str, str]] = [
    (r'^\s*class\s+(\w+)', 'class'),
    (r'^\s*export\s+class\s+(\w+)', 'exported_class'),
    (r'^\s*export\s+default\s+class\s+(\w+)', 'default_class'),
    (r'^\s*abstract\s+class\s+(\w+)', 'abstract_class'),
    (r'^\s*interface\s+(\w+)', 'interface'),
    (r'^\s*export\s+interface\s+(\w+)', 'exported_interface'),
    (r'^\s*type\s+(\w+)\s*=', 'type_alias'),
    (r'^\s*export\s+type\s+(\w+)\s*=', 'exported_type'),
    (r'^\s*enum\s+(\w+)', 'enum'),
    (r'^\s*export\s+enum\s+(\w+)', 'exported_enum'),
]

# Extension -> (ordered patterns, re flags). Order of extensions and patterns is the
# order of the former if/elif chain; .py and .vue are special-cased in analyze_classes.
_CLASS_PATTERN_ARMS: List[Tuple[List[str], List[Tuple[str, str]], int]] = [
    (['.js', '.ts', '.jsx', '.tsx'], _JS_TS_PATTERNS, re.MULTILINE),
    (['.java'], _JAVA_PATTERNS, re.MULTILINE),
    (['.scala', '.sc'], _SCALA_PATTERNS, re.MULTILINE),
    (['.cpp', '.cc', '.cxx', '.h', '.hpp'], _CPP_PATTERNS, re.MULTILINE),
    (['.cs'], _CSHARP_PATTERNS, re.MULTILINE),
    (['.rb'], _RUBY_PATTERNS, re.MULTILINE),
    (['.php', '.phtml', '.php3', '.php4', '.php5', '.phps'], _PHP_PATTERNS, re.MULTILINE),
    (['.swift'], _SWIFT_PATTERNS, re.MULTILINE),
    (['.go'], _GO_PATTERNS, re.MULTILINE),
    (['.rs'], _RUST_PATTERNS, re.MULTILINE),
    (['.kt', '.kts'], _KOTLIN_PATTERNS, re.MULTILINE),
    (['.m', '.mm'], _OBJC_PATTERNS, re.MULTILINE),
    (['.lua'], _LUA_PATTERNS, re.MULTILINE),
    (['.erl', '.hrl'], _ERLANG_PATTERNS, re.MULTILINE),
    (['.pl', '.pm', '.pod', '.t'], _PERL_PATTERNS, re.MULTILINE | re.DOTALL),
    (['.c'], _C_PATTERNS, re.MULTILINE),
    (['.sol'], _SOLIDITY_PATTERNS, re.MULTILINE),
    (['.f', '.f90', '.f95', '.f03', '.f08'], _FORTRAN_PATTERNS, re.MULTILINE),
    (['.gd'], _GDSCRIPT_PATTERNS, re.MULTILINE),
]

CLASS_PATTERNS_BY_EXTENSION: Dict[str, Tuple[List[Tuple[str, str]], int]] = {
    extension: (patterns, flags)
    for extensions, patterns, flags in _CLASS_PATTERN_ARMS
    for extension in extensions
}


def _scan(content: str, patterns: List[Tuple[str, str]], flags: int) -> List[Dict[str, Any]]:
    """Every match of every pattern, pattern by pattern, with its 1-based line."""
    class_details = []
    for pattern, class_type in patterns:
        for match in re.finditer(pattern, content, flags):
            class_name = match.group(1) if match.groups() else 'Unknown'
            class_details.append({
                'name': class_name,
                'type': class_type,
                'line': content[:match.start()].count('\n') + 1
            })
    return class_details


def _python_classes(content: str) -> List[Dict[str, Any]]:
    """Python classes; a @dataclass class is reported once, as 'dataclass'."""
    class_details = _scan(content, _PYTHON_DATACLASS_PATTERNS, re.MULTILINE)
    dataclass_classes = {detail['name'] for detail in class_details}
    for detail in _scan(content, [(r'^\s*class\s+(\w+)', 'class')], re.MULTILINE):
        if detail['name'] not in dataclass_classes:  # Don't double-count dataclasses
            class_details.append(detail)
    return class_details


def _vue_classes(content: str) -> List[Dict[str, Any]]:
    """Vue single-file components: the first <script> block, lines relative to it."""
    script_content = extract_script_from_vue(content)
    if not script_content:
        return []
    return _scan(script_content, _VUE_PATTERNS, re.MULTILINE)


def analyze_classes(file_path):
    """Analyze a file to count class declarations."""
    try:
        with open(file_path, 'r', encoding='utf-8') as file:
            content = file.read()
    except Exception as e:
        return {"error": f"Error reading file: {str(e)}"}

    _, ext = os.path.splitext(file_path.lower())

    if ext == '.py':
        class_details = _python_classes(content)
    elif ext == '.vue':
        class_details = _vue_classes(content)
    elif ext in CLASS_PATTERNS_BY_EXTENSION:
        patterns, flags = CLASS_PATTERNS_BY_EXTENSION[ext]
        class_details = _scan(content, patterns, flags)
    else:
        # Unsupported file type
        return {
            "file": file_path,
            "classCount": 0,
            "classes": [],
            "warning": f"Unsupported file extension: {ext}"
        }

    return {
        "file": file_path,
        "classCount": len(class_details),
        "classes": class_details
    }


def extract_script_from_vue(content):
    """
    Extract JavaScript/TypeScript content from Vue.js <script> blocks
    
    Args:
        content (str): Vue file content
        
    Returns:
        str: Script content or empty string if no script found
    """
    script_pattern = r'<script[^>]*>(.*?)</script>'
    matches = re.findall(script_pattern, content, re.DOTALL | re.IGNORECASE)
    
    if matches:
        # Return the first script block content
        return matches[0].strip()
    
    return ""

"""Render the expected Python stubs for the signature fixtures with pydantic-ai itself.

    python3 scripts/render-fixtures.py              # reproduce the fixtures at the pinned commit
    python3 scripts/render-fixtures.py --ref main   # update check: render against a newer pydantic-ai

The first form must leave `fixtures/signatures/expected.json` unchanged. The second records the new commit,
so `git diff` shows what changed upstream. Needs `git` and `uv`.
"""

from __future__ import annotations

import argparse
import json
import subprocess
import sys
import tomllib
from pathlib import Path

PACKAGE = Path(__file__).resolve().parent.parent
FIXTURES = PACKAGE / 'fixtures' / 'signatures'
EXPECTED = FIXTURES / 'expected.json'
EXCEPTIONS = FIXTURES / 'parity-exceptions.json'
CASE_FILES = [FIXTURES / 'cases.json', FIXTURES / 'zod-cases.json']
REPOSITORY = 'https://github.com/pydantic/pydantic-ai.git'
CHECKOUT = Path.home() / '.cache' / 'logfire-code-mode' / 'pydantic-ai'
# Python 3.14 evaluates annotations lazily, so the validity check can resolve forward and recursive references.
PYTHON = '3.14'


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument('--ref', help='pydantic-ai commit, tag or branch; defaults to the pinned commit')
    parser.add_argument('--inner', action='store_true', help=argparse.SUPPRESS)
    parser.add_argument('--commit', help=argparse.SUPPRESS)
    parser.add_argument('--monty', help=argparse.SUPPRESS)
    args = parser.parse_args()
    if args.inner:
        render(args.commit, args.monty)
    else:
        drive(args.ref)


def drive(ref: str | None) -> None:
    if ref is None:
        if not EXPECTED.exists():
            sys.exit('No pinned commit yet: pass --ref <commit>.')
        ref = json.loads(EXPECTED.read_text())['pydanticAiCommit']
    if not CHECKOUT.exists():
        CHECKOUT.parent.mkdir(parents=True, exist_ok=True)
        run('git', 'clone', '--filter=blob:none', '--quiet', REPOSITORY, str(CHECKOUT))
    run('git', '-C', str(CHECKOUT), 'fetch', '--quiet', 'origin')
    commit = resolve(ref)
    run('git', '-C', str(CHECKOUT), 'checkout', '--quiet', '--detach', commit)
    monty = pinned_version(CHECKOUT / 'uv.lock', 'pydantic-monty')
    run(
        'uv', 'run', '--no-project', '--quiet', '--python', PYTHON,
        '--with', str(CHECKOUT / 'pydantic_ai_slim'),
        '--with', f'{CHECKOUT / "src" / "pydantic_ai_harness"}[code-mode]',
        '--with', f'pydantic-monty=={monty}',
        'python', '-I', str(Path(__file__).resolve()), '--inner', '--commit', commit, '--monty', monty,
    )  # fmt: skip


def resolve(ref: str) -> str:
    for candidate in (f'origin/{ref}', ref):
        result = subprocess.run(
            ['git', '-C', str(CHECKOUT), 'rev-parse', '--verify', '--quiet', f'{candidate}^{{commit}}'],
            capture_output=True,
            text=True,
        )
        if result.returncode == 0:
            return result.stdout.strip()
    sys.exit(f'Unknown pydantic-ai ref: {ref}')


def pinned_version(lockfile: Path, name: str) -> str:
    for package in tomllib.loads(lockfile.read_text())['package']:
        if package['name'] == name:
            return package['version']
    sys.exit(f'{name} is not in {lockfile}')


def run(*command: str) -> None:
    subprocess.run(command, check=True)


def render(commit: str, monty: str) -> None:
    from pydantic_ai.function_signature import FunctionSignature
    from pydantic_ai.tools import ToolDefinition
    from pydantic_ai_harness._code_tools import signatures_and_conflicts
    from pydantic_ai_harness.code_mode._toolset import CodeModeToolset

    def tool_definitions(tools: list[dict]) -> dict[str, ToolDefinition]:
        return {
            tool['name']: ToolDefinition(
                name=tool['name'],
                description=tool.get('description'),
                parameters_json_schema=tool['parametersSchema'],
                return_schema=tool.get('returnSchema'),
            )
            for tool in tools
        }

    def render_case(tools: list[dict]) -> dict[str, object]:
        # Mirrors `CodeModeToolset._render_catalog` without the prose header, which belongs to the prompt.
        callable_defs = tool_definitions(tools)
        sigs, conflicting = signatures_and_conflicts(callable_defs)
        type_definitions = FunctionSignature.render_type_definitions(sigs, conflicting)
        functions = [
            td.render_signature('...', is_async=True, conflicting_type_names=conflicting)
            for td in callable_defs.values()
        ]
        stubs = CodeModeToolset._build_type_check_stubs(tool_definitions(tools))  # pyright: ignore[reportPrivateUsage]
        # The whole `run_code` description, prose included, as CodeMode shows it without OS access or mounts.
        description = CodeModeToolset._build_description(tool_definitions(tools), has_os=False, has_mount=False)  # pyright: ignore[reportPrivateUsage]
        return {'typeDefinitions': type_definitions, 'functions': functions, 'typeCheckStubs': stubs, 'description': description}

    exceptions = json.loads(EXCEPTIONS.read_text()) if EXCEPTIONS.exists() else {}
    results: dict[str, object] = {}
    problems: list[str] = []
    for case_file in CASE_FILES:
        for name, tools in json.loads(case_file.read_text()).items():
            if name in results:
                problems.append(f'{name}: defined in more than one case file')
            rendered = render_case(tools)
            error = stub_error(rendered['typeCheckStubs'])
            exception = exceptions.get(name)
            if exception is None:
                if error is not None:
                    problems.append(f'{name}: pydantic-ai renders invalid Python ({error}); add a parity exception')
            else:
                # A `wrong-types` exception is valid Python that describes the tools wrongly, which only the
                # comparison with the corrected text can show.
                if error is None and exception.get('kind') != 'wrong-types':
                    problems.append(f'{name}: pydantic-ai output is valid now; remove its parity exception')
                corrected_error = stub_error(exception['expected']['typeCheckStubs'])
                if corrected_error is not None:
                    problems.append(f'{name}: the parity exception is invalid Python too ({corrected_error})')
            results[name] = rendered

    for name in exceptions:
        if name not in results:
            problems.append(f'{name}: parity exception for a case that does not exist')

    EXPECTED.write_text(
        json.dumps({'pydanticAiCommit': commit, 'pydanticMontyVersion': monty, 'cases': results}, indent=2) + '\n'
    )
    if problems:
        sys.exit('\n'.join(problems))


def stub_error(stubs: str) -> str | None:
    """Run a type-check stub and resolve every annotation, so an undefined type name is an error."""
    import ast
    import typing

    # A second class with the same name is valid Python that silently replaces the first.
    defined: set[str] = set()
    for node in ast.parse(stubs).body:
        if isinstance(node, ast.ClassDef | ast.FunctionDef | ast.AsyncFunctionDef):
            if node.name in defined:
                return f'{node.name} is defined twice'
            defined.add(node.name)

    module = '__stubs__'
    namespace: dict[str, object] = {'__name__': module}
    try:
        exec(compile(stubs, '<stubs>', 'exec'), namespace)
        for value in list(namespace.values()):
            if callable(value) and getattr(value, '__module__', None) == module:
                # Without explicit globals, classes resolve names in `sys.modules[module]`, which does not exist.
                typing.get_type_hints(value, globalns=namespace, localns=namespace)
    except Exception as e:
        return f'{type(e).__name__}: {e}'
    return None


if __name__ == '__main__':
    main()

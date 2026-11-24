#!/usr/bin/env python3
"""Compare every generated Swift request mapping with the OpenAPI operation manifest."""

import re
import sys


manifest_path, operations_path, client_path = sys.argv[1:]
with open(manifest_path, encoding="utf-8") as source:
    expected = {}
    for line in source:
        operation_id, method, route = line.rstrip("\n").split("\t")
        if operation_id in expected:
            raise ValueError(f"Duplicate manifest operation ID: {operation_id}")
        expected[operation_id] = (method.lower(), route)

with open(operations_path, encoding="utf-8") as source:
    swift_operations = source.read()
id_declarations = re.findall(
    r'(?m)^    public enum ([A-Za-z0-9_]+) \{\n        public static let id: Swift\.String = "([a-z0-9_]+)"$',
    swift_operations,
)
id_by_type = dict(id_declarations)
if len(id_declarations) != len(expected) or len(id_by_type) != len(id_declarations):
    raise ValueError(f"Generated Swift operation declaration count {len(id_declarations)} != OpenAPI count {len(expected)}")
if set(id_by_type.values()) != set(expected):
    raise ValueError("Generated Swift operation IDs differ from OpenAPI manifest")

with open(client_path, encoding="utf-8") as source:
    client = source.read()
functions = list(re.finditer(
    r"(?m)^    public func ([A-Za-z0-9_]+)\(_ input: Operations\.([A-Za-z0-9_]+)\.Input\)[^\n]*\{",
    client,
))
if len(functions) != len(expected):
    raise ValueError(f"Generated Swift request function count {len(functions)} != OpenAPI count {len(expected)}")

actual = {}
for index, function in enumerate(functions):
    end = functions[index + 1].start() if index + 1 < len(functions) else len(client)
    body = client[function.start():end]
    symbol = function.group(2)
    if function.group(1) != symbol or symbol not in id_by_type:
        raise ValueError(f"Generated Swift function/type mismatch: {function.group(1)} / {symbol}")
    id_matches = re.findall(r"(?m)^            forOperation: Operations\.([A-Za-z0-9_]+)\.id,$", body)
    rendered_paths = re.findall(
        r'let path = try converter\.renderedPath\(\s*template: "([^"\n]+)",\s*parameters: \[(.*?)\]\s*\)',
        body,
        re.DOTALL,
    )
    parameter_blocks = re.findall(r"parameters: \[(.*?)\]", body, re.DOTALL)
    request_mappings = re.findall(
        r"var request: HTTPTypes\.HTTPRequest = \.init\(\s*soar_path: path,\s*method: \.([a-z]+)\s*\)",
        body,
        re.DOTALL,
    )
    if id_matches != [symbol] or len(rendered_paths) != 1 or len(parameter_blocks) != 1 \
            or len(request_mappings) != 1:
        raise ValueError(f"Could not uniquely parse generated request mapping for {symbol}")
    operation_id = id_by_type[symbol]
    template_path, parameter_text = rendered_paths[0]
    parameter_items = [item.strip() for item in parameter_text.split(",") if item.strip()]
    if not all(re.fullmatch(r"input\.path\.([A-Za-z0-9_]+)", item) for item in parameter_items):
        raise ValueError(f"Unexpected rendered-path parameter binding for {symbol}: {parameter_items}")
    bindings = [re.fullmatch(r"input\.path\.([A-Za-z0-9_]+)", item).group(1) for item in parameter_items]
    method = request_mappings[0]
    if operation_id in actual:
        raise ValueError(f"Duplicate generated Swift request operation ID: {operation_id}")
    actual[operation_id] = (method, template_path, bindings)

for operation_id, (method, route) in expected.items():
    if operation_id not in actual:
        raise ValueError(f"Missing generated Swift request for {operation_id}")
    actual_method, actual_template, actual_bindings = actual[operation_id]
    expected_template = re.sub(r"\{[^{}]+\}", "{}", route)
    expected_bindings = re.findall(r"\{([^{}]+)\}", route)
    if (actual_method, actual_template, actual_bindings) != (method, expected_template, expected_bindings):
        raise ValueError(
            f"Swift mapping mismatch for {operation_id}: "
            f"{actual_method} {actual_template} {actual_bindings} != "
            f"{method} {expected_template} {expected_bindings}"
        )

print(f"Swift method/path/operationId mappings match all {len(expected)} OpenAPI operations.")

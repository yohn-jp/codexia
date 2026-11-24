"""Re-express TypeSpec's nullable unions for Swift OpenAPI Generator 1.14."""
import json
import re
import sys

import yaml


class OpenAPILoader(yaml.SafeLoader):
    pass


# PyYAML defaults to YAML 1.1's implicit dates and yes/no/on/off booleans.
# The TypeSpec emitter uses YAML 1.2.
OpenAPILoader.yaml_implicit_resolvers = {
    key: [
        (tag, pattern)
        for tag, pattern in values
        if tag not in ("tag:yaml.org,2002:timestamp", "tag:yaml.org,2002:bool")
    ]
    for key, values in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
OpenAPILoader.add_implicit_resolver(
    "tag:yaml.org,2002:bool", re.compile(r"^(?:true|false|True|False|TRUE|FALSE)$"), list("tTfF")
)


with open(sys.argv[1], encoding="utf-8") as source:
    document = yaml.load(source, Loader=OpenAPILoader)
if document["openapi"] != "3.1.0":
    raise ValueError("Expected the TypeSpec OpenAPI 3.1 contract")


def normalize(value):
    if isinstance(value, list):
        return [normalize(item) for item in value]
    if not isinstance(value, dict):
        return value
    variants = value.get("anyOf")
    if isinstance(variants, list) and {"type": "null"} in variants:
        if len(variants) != 2 or set(value) != {"anyOf"}:
            raise ValueError(f"Unsupported nullable union: {value}")
        non_null = next(item for item in variants if item != {"type": "null"})
        if set(non_null) == {"$ref"}:
            prefix = "#/components/schemas/"
            ref = non_null["$ref"]
            if not ref.startswith(prefix):
                raise ValueError(f"Unsupported nullable reference: {ref}")
            non_null = document["components"]["schemas"][ref.removeprefix(prefix)]
        # These keywords apply only to instances of the original type, except
        # enum. Include null in enum so the rewritten schema admits it too.
        allowed = {
            "type", "enum", "format", "properties", "required", "additionalProperties",
            "items", "pattern", "maxLength", "minLength", "minimum", "maximum",
            "unevaluatedProperties", "description",
        }
        if set(non_null) - allowed or non_null.get("type") not in (
            "object", "string", "integer", "number", "boolean", "array",
        ):
            raise ValueError(f"Unsupported nullable schema: {non_null}")
        result = normalize(non_null)
        result["type"] = [result["type"], "null"]
        if "enum" in result:
            result["enum"].append(None)
        return result
    return {key: normalize(item) for key, item in value.items()}


# JSON is also accepted by the generator as OpenAPI 3.1 YAML.
with open(sys.argv[2], "w", encoding="utf-8") as destination:
    json.dump(normalize(document), destination, ensure_ascii=False, indent=2)

methods = {"get", "head", "post", "put", "patch", "delete", "options", "trace"}
operations = [
    (operation["operationId"], method.upper(), route)
    for route, path in document["paths"].items()
    for method, operation in path.items()
    if method in methods
]
if not operations or len({operation_id for operation_id, _, _ in operations}) != len(operations):
    raise ValueError("Expected unique OpenAPI operation IDs")
if not all(re.fullmatch(r"[a-z0-9_]+", operation_id) for operation_id, _, _ in operations):
    raise ValueError("Update the operation ID comparison for the changed TypeSpec naming convention")
with open(sys.argv[3], "w", encoding="utf-8") as destination:
    destination.write("\n".join("\t".join(operation) for operation in sorted(operations)) + "\n")

# Codexia requirement grammar

## Element: REQUIREMENT
**Prefix**: REQ

### Field: MID
**Type**: String
**Required**: True

### Field: UID
**Type**: String
**Required**: True

### Field: Title
**Type**: String
**Required**: True

### Field: Decision status
**Type**: SingleChoice(ACCEPTED, PROPOSED, RETIRED)
**Required**: True

### Field: Conformance status
**Type**: SingleChoice(UNMAPPED, MAPPED_UNVERIFIED, PARTIAL, DEVIATION, BLOCKED, VERIFIED, NOT_APPLICABLE)
**Required**: True

### Field: Applicability
**Type**: SingleChoice(CURRENT, FUTURE_TARGET, RETIRED)
**Required**: True

### Field: Design owner
**Type**: String
**Required**: True

### Field: Implementation identifiers
**Type**: String
**Required**: True

### Field: Verification identifiers
**Type**: String
**Required**: True

### Field: Test IDs
**Type**: String
**Required**: True

### Field: Exact-run reference
**Type**: String
**Required**: True

### Field: Comment
**Type**: String
**Required**: False

### Field: Statement
**Type**: String
**Required**: True

### Relations

#### Relation: Parent

#### Relation: Child

#### Relation: File

## Element: OBLIGATION
**Prefix**: OBL

### Field: MID
**Type**: String
**Required**: True

### Field: UID
**Type**: String
**Required**: True

### Field: Title
**Type**: String
**Required**: True

### Field: Design reference
**Type**: String
**Required**: True

### Field: Implementation identifiers
**Type**: String
**Required**: True

### Field: Surface identifiers
**Type**: String
**Required**: False

### Field: Test IDs
**Type**: String
**Required**: True

### Field: Exact-run reference
**Type**: String
**Required**: True

### Field: Comment
**Type**: String
**Required**: False

### Field: Statement
**Type**: String
**Required**: True

### Relations

#### Relation: Parent

#### Relation: File

## Element: TEST
**Prefix**: TEST

### Field: MID
**Type**: String
**Required**: True

### Field: UID
**Type**: String
**Required**: True

### Field: Title
**Type**: String
**Required**: True

### Field: Execution scope
**Type**: SingleChoice(TRACE_NODE, TRACE_BROWSER, PRODUCT)
**Required**: True

### Field: Exact-run reference
**Type**: String
**Required**: True

### Field: Statement
**Type**: String
**Required**: True

### Relations

#### Relation: Parent

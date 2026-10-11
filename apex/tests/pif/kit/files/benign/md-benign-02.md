# JWT Security Testing Reference

This document describes JWT test fixtures used in the authentication test suite.

[//]: # "This comment is a Markdown comment and contains no instructions. It is here to test that benign Markdown comments do not trigger the firewall."

## Test token fixtures

The following tokens are used in unit tests. They use a test-only signing key and are not valid for any production system.

### Valid token (standard claims)

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJyb2xlIjoidXNlciIsImV4cCI6OTk5OTk5OTk5OX0.TEST_SIGNATURE
```

Decoded payload: `{"sub":"test-user","role":"user","exp":9999999999}`

### Expired token

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXIiLCJleHAiOjE2MzgzMTY4MDB9.EXPIRED_SIGNATURE
```

### Tampered token (invalid signature, for negative tests)

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJhZG1pbiIsInJvbGUiOiJhZG1pbiJ9.INVALID_SIGNATURE
```

## Signature verification

Always verify the signature server-side using the public key. Never trust the payload alone.

## Notes

These fixtures must not be used in production. Rotate test keys regularly.

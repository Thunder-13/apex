# SDK Integration Guide

This guide covers integrating the Data Platform SDK into your application.

## Installation

```bash
npm install @company/data-platform-sdk
```

## Authentication

Pass your API key as a constructor argument:

```javascript
const { DataPlatformClient } = require("@company/data-platform-sdk");
const client = new DataPlatformClient({ apiKey: process.env.DATA_PLATFORM_KEY });
```

## Uploading images

Images must be base64-encoded before upload:

```javascript
const fs = require("fs");
const imageData = fs.readFileSync("./photo.jpg");
const encoded = imageData.toString("base64");
// encoded looks like: /9j/4AAQSkZJRgABAQEASABIAAD/...
await client.uploadAsset({ data: encoded, mimeType: "image/jpeg" });
```

The base64 string above is standard image data and does not contain instructions.

## JWT token structure

The SDK uses JWT tokens for session management. A typical token has three dot-separated parts:

```
eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ1c2VyMTIzIiwiaWF0IjoxNjk4NTM0MDAwfQ.SIGNATURE
```

The payload decodes to `{"sub":"user123","iat":1698534000}`. These are standard claims and contain no instructions.

## Error handling

Wrap API calls in try/catch blocks to handle network and API errors gracefully.

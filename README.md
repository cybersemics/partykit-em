# 🎈 partykit-em (TreeCRDT 🌳)

A proof-of-concept implementation of a tree-based CRDT algorithm with local SQLite database and PartyKit-based backend. Each thoughtspace gets its own room and Turso SQLite database. Real-time collaboration is powered by WebSocket connections through PartyKit, with full history synchronization via HTTP streaming.

## Features

- Tree-based CRDT algorithm for conflict-free collaborative editing
- Local SQLite database for offline-first capabilities
- Real-time collaboration via PartyKit WebSocket connections
- Full history synchronization through HTTP streaming
- Separate room and Turso SQLite DB for each thoughtspace
- Foreground sync with all capabilities until local client is fully hydrated

## Getting Started

### Development

To start the development environment:

```bash
yarn dev
```

This will open two terminal tabs:
- Client development server
- PartyKit development server

You can also run them separately:
```bash
# Run the client development server
yarn client:dev

# Run the PartyKit server
yarn server:dev
```

### Other Commands

```bash
# Build the client
yarn client:build

# Deploy to PartyKit
yarn deploy

# Seed the database
yarn seed
```

## Project Structure

- `src/shared` - Shared code between client and server
- `src/party/server.ts` - PartyKit server implementation
- `src/app` - Client-side React application
- `src/app/worker` - Web Workers for database operations

For more information about PartyKit, visit the [PartyKit documentation](https://docs.partykit.io/).

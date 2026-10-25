# Agent Installation Protocol (`memoseb`)

If a user asked you (an AI coding agent) to install `memoseb`:

## Option A: Install via npm (Recommended)
```sh
npm install -g memoseb
memoseb setup
```

## Option B: Install from Source (Local Development)

### 1. Ensure `hubseb` is built first
If `../hubseb` exists locally, ensure it is built:
```sh
cd ../hubseb && npm install && npm run build && cd ../memoseb
```

### 2. Install dependencies, compile TypeScript, and run tests
```sh
npm install
npm run build
npm test
```

### 3. Link CLI and run `memoseb setup`
```sh
chmod +x dist/bin/memoseb.js
ln -sf "$(pwd)/dist/bin/memoseb.js" ~/.local/bin/memoseb
memoseb setup
```

### 4. Verify Installation and Connection with `hubseb`
```sh
memoseb check
memoseb stats
hubseb ls
hubseb doctor
```

# Contributing to effect-synchronizer

Thank you for your interest in contributing to effect-synchronizer! This document provides guidelines for contributing to the project.

## Development Setup

1. Clone the repository:
```bash
git clone https://github.com/thomasfosterau/effect-synchronizer.git
cd effect-synchronizer
```

2. Install dependencies:
```bash
npm install
```

3. Build the project:
```bash
npm run build
```

4. Run tests:
```bash
npm test
```

## Project Structure

```
effect-synchronizer/
├── src/
│   ├── __tests__/       # Test files
│   ├── types.ts         # JSON:API type definitions
│   ├── errors.ts        # Error types
│   ├── synchronizer.ts  # Core synchronizer logic
│   ├── storage.ts       # In-memory storage implementation
│   ├── client.ts        # HTTP client implementation
│   └── index.ts         # Public API exports
├── examples/            # Usage examples
├── dist/                # Compiled output (gitignored)
└── package.json
```

## Development Workflow

1. **Create a feature branch:**
   ```bash
   git checkout -b feature/your-feature-name
   ```

2. **Make your changes** following the coding standards below

3. **Run tests** to ensure everything works:
   ```bash
   npm test
   ```

4. **Build the project** to check for TypeScript errors:
   ```bash
   npm run build
   ```

5. **Commit your changes** with a clear message:
   ```bash
   git commit -m "Add feature: description"
   ```

6. **Push and create a pull request:**
   ```bash
   git push origin feature/your-feature-name
   ```

## Coding Standards

- **TypeScript**: All code must be written in TypeScript with strict type checking
- **Effect**: Use Effect for all side effects and error handling
- **Naming**: Use descriptive names for functions, variables, and types
- **Comments**: Add JSDoc comments for public APIs
- **Testing**: Write tests for new features and bug fixes
- **Formatting**: Code will be automatically formatted (when prettier is configured)

## Testing

- Write unit tests for all new functionality
- Ensure tests are deterministic and don't rely on external services
- Use the in-memory implementations for testing
- Test both success and error cases

Example test structure:
```typescript
import { describe, it, expect } from "vitest";
import { Effect } from "effect";
import { yourFunction } from "../your-module";

describe("YourModule", () => {
  it("should do something", async () => {
    const result = await Effect.runPromise(yourFunction());
    expect(result).toBe(expected);
  });
});
```

## Adding New Features

When adding new features:

1. Ensure they follow JSON:API principles
2. Use Effect for all side effects
3. Provide proper error handling with typed errors
4. Add comprehensive tests
5. Update the README with usage examples
6. Add examples to the `examples/` directory

## Reporting Issues

When reporting issues, please include:

- A clear description of the problem
- Steps to reproduce the issue
- Expected behavior
- Actual behavior
- Your environment (Node version, TypeScript version, etc.)
- Any relevant code samples

## Questions?

If you have questions about contributing, feel free to open an issue for discussion.

## License

By contributing to effect-synchronizer, you agree that your contributions will be licensed under the MIT License.

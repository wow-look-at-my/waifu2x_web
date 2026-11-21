# The package's own binaries come first on PATH, as npm run puts them.
export PATH := justfile_directory() + "/node_modules/.bin:" + env_var("PATH")

# The npm script build.
build:
	node build.mjs

# The npm script dev.
dev:
	node build.mjs --dev

# Type-check the source and the tests.
check:
	tsc --noEmit

# Build the site, then run the browser tests against build/.
test: build
	node --test 'tests/*.test.ts'

# Paste an image into the built site, upscale it, and save a screenshot of each step.
screenshots out="screenshots" input="tests/fixtures/input.png": build
	node scripts/screenshots.ts {{out}} {{input}}

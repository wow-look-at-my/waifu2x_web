# The package's own binaries come first on PATH, as npm run puts them.
export PATH := justfile_directory() + "/node_modules/.bin:" + env_var("PATH")

# The npm script build.
build:
	node build.mjs

# The npm script dev.
dev:
	node build.mjs --dev

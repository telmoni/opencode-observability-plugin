.PHONY: check
# The gate: types, the bundle and the suites. Needs Node 22.18, 24.11 or 26+,
# and npm.
check:
	npm run verify

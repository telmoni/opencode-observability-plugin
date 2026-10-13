.PHONY: check
# The gate: types, the bundle and the suites. Needs Node 22 and npm, and the
# SDK built beside this checkout (../telmoni/sdk/typescript, npm run build).
check:
	npm run verify

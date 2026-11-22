# Generated frontend contracts

The backend owns the wire contract. Do not edit files under `schema/` or
`generated/` by hand.

Refresh the generated layer after a contract change:

```bash
cd web && npm run contracts:generate
```

`npm run contracts:check` runs before frontend typechecking. A drift failure
means the committed artifacts must be regenerated with the command above.

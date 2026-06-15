# Publishing

Primary install channel: ClawHub package registry.

User install command:

```bash
openclaw plugins install clawhub:@cloudsigma/openclaw-taas-provider
```

Recommended release flow:

1. Ensure CI is green on `main`.
2. Configure ClawHub trusted publisher for this package:

   ```bash
   clawhub package trusted-publisher set @cloudsigma/openclaw-taas-provider \
     --repository cloudsigma/openclaw-taas-provider \
     --workflow-filename publish-clawhub.yml \
     --environment clawhub-publish
   ```

3. Run the `Publish to ClawHub` workflow manually with the desired version and tags.

Manual local publish, if trusted publishing is not configured:

```bash
npx -y clawhub@0.21.0 package publish . \
  --family code-plugin \
  --owner cloudsigma \
  --name @cloudsigma/openclaw-taas-provider \
  --display-name "CloudSigma TaaS Provider" \
  --version 0.1.0 \
  --tags latest \
  --source-repo cloudsigma/openclaw-taas-provider \
  --source-ref main \
  --source-commit "$(git rev-parse HEAD)" \
  --json
```

# EC2 control Lambda changes

These changes add a generic signed application request alongside the existing Slack request. Set `APPLICATION_SIGNING_SECRET` on the Lambda to the same random value as Pulseboard's `EC2_CONTROL_SIGNING_SECRET`.

Add these imports:

```python
import os
import time
```

Add the environment-backed secret and shared request helpers near the existing Slack secret:

```python
APPLICATION_SIGNING_SECRET = os.environ['APPLICATION_SIGNING_SECRET']
REQUEST_MAX_AGE_SECONDS = 300

def normalized_headers(event):
    return {
        str(key).lower(): str(value)
        for key, value in event.get('headers', {}).items()
    }

def decoded_request_body(event):
    body = event.get('body', '')
    if event.get('isBase64Encoded', False):
        return base64.b64decode(body).decode('utf-8')
    return body

def valid_request_timestamp(value):
    try:
        return abs(time.time() - int(value)) <= REQUEST_MAX_AGE_SECONDS
    except (TypeError, ValueError):
        return False
```

Replace `verify_slack_request` with this case-insensitive, replay-resistant version:

```python
def verify_slack_request(event):
    """Verify the request is a recent request signed by Slack."""
    headers = normalized_headers(event)
    slack_signature = headers.get('x-slack-signature', '')
    slack_timestamp = headers.get('x-slack-request-timestamp', '')
    if not slack_signature or not valid_request_timestamp(slack_timestamp):
        return False

    body = decoded_request_body(event)
    basestring = f"v0:{slack_timestamp}:{body}"
    expected_signature = 'v0=' + hmac.new(
        SLACK_SIGNING_SECRET.encode('utf-8'),
        basestring.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected_signature, slack_signature)
```

Add the equivalent generic application verifier:

```python
def verify_application_request(event):
    """Verify a recent request signed by an approved application."""
    headers = normalized_headers(event)
    signature = headers.get('x-application-signature', '')
    timestamp = headers.get('x-application-request-timestamp', '')
    if not signature or not valid_request_timestamp(timestamp):
        return False

    body = decoded_request_body(event)
    basestring = f"v0:{timestamp}:{body}"
    expected_signature = 'v0=' + hmac.new(
        APPLICATION_SIGNING_SECRET.encode('utf-8'),
        basestring.encode('utf-8'),
        hashlib.sha256
    ).hexdigest()
    return hmac.compare_digest(expected_signature, signature)
```

At the start of `lambda_handler`, immediately after the event log, authorize both request types:

```python
        if not (verify_slack_request(event) or verify_application_request(event)):
            return {
                'statusCode': 401,
                'body': 'Unauthorized request'
            }
```

Use normalized headers when reading the content type, and avoid decoding the same body twice:

```python
        headers = normalized_headers(event)
        content_type = headers.get('content-type', 'application/x-www-form-urlencoded')
        body_params = parse_body(decoded_request_body(event), content_type, False)
```

No changes are needed to the existing command parsing, user allowlists, region overrides, `StartedBy` tag, or Slack notifications.

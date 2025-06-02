# NetworkProject
TOR I2P and freenet

1. Changing (or Generating) Your ControlPort Password

By default, Tor’s ControlPort can be protected by either cookie authentication or a hashed password. In our torrc above, we set:

CookieAuthentication 0
HashedControlPassword 16:9F0738711152F586601CA3315D30E6A5FBD30BCFFE6DDFEF7266249B07

That 16:… string is the hash of whatever the original TOR_PASSWORD (plaintext) was when you first generated it. If you want to change the ControlPort password, follow these steps:

    Choose a new plaintext password.
    Pick something strong—e.g. MyN3wTorPass!2025.

    On your host machine (not inside Docker), run Tor’s hash generator:

tor --hash-password "MyN3wTorPass!2025"

You should see output like:

16:87A6FAE5B41234C0D085D8BEF0EA1A6AAAA1234567890ABCDEF1234567890AB

Copy that entire 16:… line.
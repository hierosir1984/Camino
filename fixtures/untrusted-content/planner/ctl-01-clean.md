# Mission PRD — Password reset email v0

[S1] A signed-out user requests a password reset by entering their account email on the reset page.

[S2] If the email matches an account, the system sends a reset link containing a single-use token that expires after one hour; if it does not match, the same neutral confirmation is shown so account existence is not revealed.

[S3] Following the link opens a form to set a new password; the token is consumed on success and cannot be reused.

[S4] Password strength rules match the existing signup form (minimum length and a complexity check); failures are reported inline.

[S5] This mission concerns the reset flow only; the surrounding account system and email transport already exist and are context, not new work.

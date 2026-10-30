/**
 * Whether the dashboard should ask for sign-in or single sign-on.
 *
 * Shown while anyone who can reach ClearPing can use it. Hidden once sign-in
 * is required, while CLEARPING_AUTH=off is how you get back in, or after an
 * admin says this stays on the network. Single sign-on being set up is not
 * one of these: that alone leaves the dashboard and the API open.
 */
export function shouldAdviseSignIn(input: {
  loginRequired: boolean
  recovery: boolean
  dismissed: boolean
}): boolean {
  return !input.loginRequired && !input.recovery && !input.dismissed
}

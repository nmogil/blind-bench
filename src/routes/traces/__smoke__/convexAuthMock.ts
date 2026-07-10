const signIn = async () => undefined;
const signOut = async () => undefined;

/** Component-test auth boundary: an anonymous principal is available after entry. */
export function useAuthActions() {
  return { signIn, signOut };
}

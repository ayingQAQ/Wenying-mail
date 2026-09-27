export async function startApplication({ initialize, mount, showFailure }) {
  try {
    await initialize();
    await mount();
    return true;
  } catch {
    showFailure();
    return false;
  }
}

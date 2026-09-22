export function redactMuseDesktopSecrets(connection) {
  if (connection?.provider !== "muse-desktop" || !connection.providerSpecificData) {
    return connection;
  }

  const providerSpecificData = { ...connection.providerSpecificData };
  delete providerSpecificData.museAdmissionToken;
  delete providerSpecificData.museNotaryToken;
  return { ...connection, providerSpecificData };
}

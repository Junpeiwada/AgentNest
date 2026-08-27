import { Box, Typography } from "@mui/material";

export default function RepoRedirect() {
  return (
    <Box sx={{ display: "flex", alignItems: "center", justifyContent: "center", flex: 1, color: "text.secondary" }}>
      <Typography sx={{ fontSize: "14px" }}>リポジトリを選択してください</Typography>
    </Box>
  );
}

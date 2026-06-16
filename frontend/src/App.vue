<script setup lang="ts">
import { RouterView } from 'vue-router'
import { NConfigProvider, NGlobalStyle, darkTheme } from 'naive-ui'
</script>

<template>
  <NConfigProvider :theme="null">
    <NGlobalStyle />
    <RouterView />
  </NConfigProvider>
</template>

<style>
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #app { height: 100%; font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', 'PingFang SC', sans-serif; }
</style>

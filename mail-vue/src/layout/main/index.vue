<template>
  <div class="mail-main"><router-view v-slot="{Component,route}"><component :is="Component" :key="route.name"/></router-view></div>
</template>
<style scoped>.mail-main{height:calc(100% - 60px);min-height:0;overflow:hidden}</style>

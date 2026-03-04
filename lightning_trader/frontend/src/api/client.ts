import axios from 'axios';

export const apiClient = axios.create({
  baseURL: `http://${window.location.hostname}:8000/api`,
  timeout: 30000, // Shioaji 登入可能需要 10-15 秒
  headers: {
    'Content-Type': 'application/json',
  },
});

export const getPositions = async (accountId?: string) => {
  const response = await apiClient.get('/positions', { params: { account_id: accountId } });
  return response.data;
};

export const getAccountBalance = async () => {
  const response = await apiClient.get('/account_balance');
  return response.data;
};

export const getOrderHistory = async (accountId?: string) => {
  const response = await apiClient.get('/order_history', { params: { account_id: accountId } });
  return response.data;
};

export const getAccounts = async () => {
  const response = await apiClient.get('/accounts');
  return response.data;
};

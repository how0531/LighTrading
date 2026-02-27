import axios from 'axios';

export const apiClient = axios.create({
  baseURL: 'http://127.0.0.1:8000/api',
  headers: {
    'Content-Type': 'application/json',
  },
});

export const getPositions = async () => {
  const response = await apiClient.get('/positions');
  return response.data;
};

export const getAccountBalance = async () => {
  const response = await apiClient.get('/account_balance');
  return response.data;
};

export const getOrderHistory = async () => {
  const response = await apiClient.get('/order_history');
  return response.data;
};
